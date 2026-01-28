const express = require('express');
const router = express.Router();
const { query, transaction } = require('../config/database');
const { authMiddleware, eleveMiddleware } = require('../middleware/auth');

// Protection: toutes les routes nécessitent authentification élève
router.use(authMiddleware, eleveMiddleware);

/**
 * GET /api/eleves/ateliers-disponibles
 * Liste des ateliers disponibles pour l'élève
 */
router.get('/ateliers-disponibles', async (req, res) => {
    try {
        const eleveUserId = req.user.id;
        
        // Récupérer les infos de l'élève et sa classe
        const eleves = await query(`
            SELECT e.*, c.nom as classe_nom
            FROM eleves e
            JOIN classes c ON e.classe_id = c.id
            WHERE e.utilisateur_id = ?
        `, [eleveUserId]);
        
        if (eleves.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Élève non trouvé'
            });
        }
        
        const eleve = eleves[0];
        
        // Vérifier si les inscriptions sont ouvertes POUR CETTE CLASSE uniquement
        const configClasse = await query(`
            SELECT inscriptions_ouvertes FROM classes WHERE id = ?
        `, [eleve.classe_id]);
        const inscriptionsOuvertes = configClasse[0]?.inscriptions_ouvertes === 1 || configClasse[0]?.inscriptions_ouvertes === true;
        
        // Récupérer le pourcentage de places disponibles (quota progressif)
        const quotaConfig = await query(`
            SELECT valeur FROM configuration WHERE cle = 'quota_places_pourcent'
        `);
        const quotaPourcent = parseFloat(quotaConfig[0]?.valeur || 100);
        
        // Récupérer les ateliers disponibles avec places restantes
        const ateliers = await query(`
            SELECT 
                a.id,
                a.nom,
                a.description,
                a.duree,
                a.nombre_places_max,
                a.informations_eleves,
                u.nom as enseignant_nom,
                u.prenom as enseignant_prenom,
                a.enseignant_acronyme as enseignant1_acronyme,
                a.enseignant2_acronyme,
                a.enseignant3_acronyme,
                p.id as planning_id,
                p.creneau_id,
                p.nombre_creneaux,
                c.jour,
                c.periode,
                c.ordre as creneau_ordre,
                c.heure_debut,
                c.heure_fin,
                s.nom as salle_nom,
                COUNT(DISTINCT i.id) as nombre_inscrits,
                GREATEST(CEILING(a.nombre_places_max * ? / 100) - COUNT(DISTINCT i.id), 0) as places_restantes,
                a.nombre_places_max as places_totales,
                EXISTS(
                    SELECT 1 FROM inscriptions i2 
                    WHERE i2.atelier_id = a.id 
                    AND i2.eleve_id = ?
                    AND i2.statut != 'annulee'
                ) as deja_inscrit
            FROM ateliers a
            JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            LEFT JOIN planning p ON a.id = p.atelier_id
            LEFT JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            LEFT JOIN inscriptions i ON a.id = i.atelier_id AND i.statut = 'confirmee'
            WHERE a.statut = 'valide'
            GROUP BY a.id, p.id
            ORDER BY c.ordre, a.nom
        `, [quotaPourcent, eleve.id]);
        
        res.json({
            success: true,
            inscriptions_ouvertes: inscriptionsOuvertes,
            quota_pourcent: quotaPourcent,
            data: ateliers,
            eleve_info: {
                id: eleve.id,
                classe: eleve.classe_nom,
                classe_id: eleve.classe_id
            }
        });
        
    } catch (error) {
        console.error('Erreur ateliers disponibles:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération des ateliers'
        });
    }
});

/**
 * GET /api/eleves/mes-inscriptions
 * Liste des inscriptions de l'élève
 */
router.get('/mes-inscriptions', async (req, res) => {
    try {
        const eleveUserId = req.user.id;
        
        // Récupérer l'ID élève
        const eleves = await query(`
            SELECT id FROM eleves WHERE utilisateur_id = ?
        `, [eleveUserId]);
        
        if (eleves.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Élève non trouvé'
            });
        }
        
        const eleveId = eleves[0].id;
        
        // Récupérer les inscriptions avec les créneaux couverts
        const inscriptions = await query(`
            SELECT 
                i.id,
                i.statut,
                i.date_inscription,
                i.inscription_manuelle,
                a.id as atelier_id,
                a.nom as atelier_nom,
                a.description as atelier_description,
                a.informations_eleves,
                a.duree,
                u.nom as enseignant_nom,
                u.prenom as enseignant_prenom,
                p.id as planning_id,
                p.creneau_id,
                p.nombre_creneaux,
                c.jour,
                c.periode,
                c.ordre as creneau_ordre,
                c.heure_debut,
                c.heure_fin,
                s.nom as salle_nom
            FROM inscriptions i
            JOIN ateliers a ON i.atelier_id = a.id
            LEFT JOIN planning p ON i.planning_id = p.id
            LEFT JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            WHERE i.eleve_id = ? AND i.statut != 'annulee'
            ORDER BY c.ordre
        `, [eleveId]);
        
        res.json({
            success: true,
            data: inscriptions
        });
        
    } catch (error) {
        console.error('Erreur mes inscriptions:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération des inscriptions'
        });
    }
});

/**
 * POST /api/eleves/inscrire/:planningId
 * S'inscrire à un atelier
 */
router.post('/inscrire/:planningId', async (req, res) => {
    try {
        const { planningId } = req.params;
        const eleveUserId = req.user.id;
        
        // Récupérer l'élève
        const eleves = await query(`
            SELECT e.*, c.nom as classe_nom
            FROM eleves e
            JOIN classes c ON e.classe_id = c.id
            WHERE e.utilisateur_id = ?
        `, [eleveUserId]);
        
        if (eleves.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Élève non trouvé'
            });
        }
        
        const eleve = eleves[0];
        
        // Vérifier que les inscriptions sont ouvertes
        const config = await query(`
            SELECT valeur FROM configuration WHERE cle = 'inscriptions_ouvertes'
        `);
        
        const inscriptionsOuvertes = config[0]?.valeur === 'true' || config[0]?.valeur === '1';
        
        if (!inscriptionsOuvertes) {
            return res.status(403).json({
                success: false,
                message: 'Les inscriptions sont fermées'
            });
        }
        
        // Récupérer les infos du planning
        const plannings = await query(`
            SELECT p.*, a.nombre_places_max, a.id as atelier_id
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            WHERE p.id = ?
        `, [planningId]);
        
        if (plannings.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Atelier non trouvé dans le planning'
            });
        }
        
        const planning = plannings[0];
        
        // Vérifier qu'il reste des places
        const inscrits = await query(`
            SELECT COUNT(*) as count
            FROM inscriptions
            WHERE planning_id = ? AND statut = 'confirmee'
        `, [planningId]);
        
        if (inscrits[0].count >= planning.nombre_places_max) {
            return res.status(400).json({
                success: false,
                message: 'Atelier complet, plus de places disponibles'
            });
        }
        
        // Vérifier que l'élève n'est pas déjà inscrit
        const dejaInscrit = await query(`
            SELECT id FROM inscriptions
            WHERE eleve_id = ? AND atelier_id = ? AND statut != 'annulee'
        `, [eleve.id, planning.atelier_id]);
        
        if (dejaInscrit.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Vous êtes déjà inscrit à cet atelier'
            });
        }
        
        // Vérifier les conflits horaires (AMÉLIORÉ V5 - multi-périodes)
        // Récupérer l'atelier et ses créneaux
        const atelierInfo = await query(`
            SELECT a.duree, p.creneau_debut_id, p.nombre_creneaux, c.jour
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_debut_id = c.id
            WHERE p.id = ?
        `, [planningId]);
        
        if (atelierInfo.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Planning non trouvé'
            });
        }
        
        const nouvelAtelier = atelierInfo[0];
        
        // Récupérer tous les créneaux occupés par ce nouvel atelier
        const creneauxNouvelAtelier = await query(`
            SELECT id, jour, periode, ordre
            FROM creneaux
            WHERE jour = ? AND ordre >= (
                SELECT ordre FROM creneaux WHERE id = ?
            ) AND ordre < (
                SELECT ordre + ? FROM creneaux WHERE id = ?
            )
        `, [
            nouvelAtelier.jour,
            nouvelAtelier.creneau_debut_id,
            nouvelAtelier.nombre_creneaux,
            nouvelAtelier.creneau_debut_id
        ]);
        
        const creneauxIds = creneauxNouvelAtelier.map(c => c.id);
        
        // Vérifier si l'élève a déjà un atelier sur UN de ces créneaux
        const conflits = await query(`
            SELECT 
                a.nom as atelier_nom,
                a.duree,
                c.jour,
                c.periode,
                c2.periode as periode_conflit
            FROM inscriptions i
            JOIN planning p ON i.planning_id = p.id
            JOIN ateliers a ON i.atelier_id = a.id
            JOIN creneaux c ON p.creneau_debut_id = c.id
            JOIN creneaux c2 ON c2.jour = c.jour 
                AND c2.ordre >= c.ordre 
                AND c2.ordre < c.ordre + p.nombre_creneaux
            WHERE i.eleve_id = ? 
            AND i.statut = 'confirmee'
            AND c2.id IN (?)
        `, [eleve.id, creneauxIds]);
        
        if (conflits.length > 0) {
            const conflit = conflits[0];
            return res.status(400).json({
                success: false,
                message: `Conflit horaire avec l'atelier "${conflit.atelier_nom}" (${conflit.jour} ${conflit.periode_conflit})`
            });
        }
        
        // Vérification spéciale : ateliers 6 périodes bloquent toute la journée
        if (nouvelAtelier.duree === 6) {
            // Vérifier qu'aucun autre atelier ce jour-là
            const autresAteliersJour = await query(`
                SELECT COUNT(*) as count
                FROM inscriptions i
                JOIN planning p ON i.planning_id = p.id
                JOIN creneaux c ON p.creneau_debut_id = c.id
                WHERE i.eleve_id = ? 
                AND i.statut = 'confirmee'
                AND c.jour = ?
            `, [eleve.id, nouvelAtelier.jour]);
            
            if (autresAteliersJour[0].count > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Impossible : cet atelier de 6 périodes occupe toute la journée et vous êtes déjà inscrit à un autre atelier ce jour-là'
                });
            }
        }
        
        // Vérification inverse : si élève a déjà un 6p ce jour, bloquer
        const atelier6pCeJour = await query(`
            SELECT a.nom
            FROM inscriptions i
            JOIN planning p ON i.planning_id = p.id
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_debut_id = c.id
            WHERE i.eleve_id = ? 
            AND i.statut = 'confirmee'
            AND c.jour = ?
            AND a.duree = 6
        `, [eleve.id, nouvelAtelier.jour]);
        
        if (atelier6pCeJour.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Impossible : vous êtes déjà inscrit à l'atelier "${atelier6pCeJour[0].nom}" qui occupe toute la journée ${nouvelAtelier.jour}`
            });
        }
        
        // Inscrire l'élève
        const result = await query(`
            INSERT INTO inscriptions (eleve_id, atelier_id, planning_id, statut)
            VALUES (?, ?, ?, 'confirmee')
        `, [eleve.id, planning.atelier_id, planningId]);
        
        // Log
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'INSCRIPTION', 'inscriptions', result.insertId, `Inscription atelier ${planning.atelier_id}`]
        );
        
        res.json({
            success: true,
            message: 'Inscription réussie !',
            data: {
                inscription_id: result.insertId
            }
        });
        
    } catch (error) {
        console.error('Erreur inscription:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de l\'inscription'
        });
    }
});

/**
 * DELETE /api/eleves/desinscrire/:inscriptionId
 * Se désinscrire d'un atelier
 */
router.delete('/desinscrire/:inscriptionId', async (req, res) => {
    try {
        const { inscriptionId } = req.params;
        const eleveUserId = req.user.id;
        
        // Récupérer l'élève
        const eleves = await query(`
            SELECT id FROM eleves WHERE utilisateur_id = ?
        `, [eleveUserId]);
        
        if (eleves.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Élève non trouvé'
            });
        }
        
        const eleveId = eleves[0].id;
        
        // Vérifier que l'inscription appartient à l'élève et n'est pas manuelle
        const inscriptions = await query(`
            SELECT * FROM inscriptions
            WHERE id = ? AND eleve_id = ?
        `, [inscriptionId, eleveId]);
        
        if (inscriptions.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Inscription non trouvée'
            });
        }
        
        const inscription = inscriptions[0];
        
        if (inscription.inscription_manuelle) {
            return res.status(403).json({
                success: false,
                message: 'Impossible de se désinscrire d\'un atelier obligatoire'
            });
        }
        
        // Annuler l'inscription
        await query(`
            UPDATE inscriptions SET statut = 'annulee' WHERE id = ?
        `, [inscriptionId]);
        
        // Log
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'DESINSCRIPTION', 'inscriptions', inscriptionId, 'Désinscription atelier']
        );
        
        res.json({
            success: true,
            message: 'Désinscription réussie'
        });
        
    } catch (error) {
        console.error('Erreur désinscription:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la désinscription'
        });
    }
});

module.exports = router;
