const express = require('express');
const router = express.Router();
const { query, transaction } = require('../config/database');
const { authMiddleware, eleveMiddleware } = require('../middleware/auth');

// Protection: toutes les routes nécessitent authentification élève
router.use(authMiddleware, eleveMiddleware);

/**
 * GET /api/eleves/ateliers-disponibles
 * Liste des ateliers disponibles pour l'élève avec créneaux et places
 */
router.get('/ateliers-disponibles', async (req, res) => {
    try {
        const eleveUserId = req.user.id;
        
        // Récupérer les infos de l'élève et sa classe
        const eleves = await query(`
            SELECT e.*, c.nom as classe_nom, c.inscriptions_ouvertes
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
        const inscriptionsOuvertes = eleve.inscriptions_ouvertes === 1 || eleve.inscriptions_ouvertes === true;
        
        // Récupérer le pourcentage de places disponibles (quota progressif)
        const quotaConfig = await query(`
            SELECT valeur FROM configuration WHERE cle = 'quota_places_pourcent'
        `);
        const quotaPourcent = parseFloat(quotaConfig[0]?.valeur || 100);
        
        // Récupérer les créneaux où l'élève est déjà inscrit (pour détecter conflits)
        const inscriptionsEleve = await query(`
            SELECT 
                i.id as inscription_id,
                p.creneau_id,
                p.nombre_creneaux
            FROM inscriptions i
            JOIN planning p ON i.planning_id = p.id
            WHERE i.eleve_id = ? AND i.statut = 'confirmee'
        `, [eleve.id]);
        
        // Créer un Set des créneaux occupés par l'élève
        const creneauxOccupes = new Set();
        inscriptionsEleve.forEach(insc => {
            for (let i = 0; i < insc.nombre_creneaux; i++) {
                creneauxOccupes.add(insc.creneau_id + i);
            }
        });
        
        // Debug: tester chaque JOIN séparément
        const debug1 = await query(`SELECT COUNT(*) as c FROM ateliers WHERE statut = 'valide'`);
        const debug2 = await query(`SELECT COUNT(*) as c FROM planning`);
        const debug3 = await query(`SELECT COUNT(*) as c FROM ateliers a INNER JOIN planning p ON a.id = p.atelier_id WHERE a.statut = 'valide'`);
        const debug4 = await query(`SELECT COUNT(*) as c FROM creneaux`);
        const debug5 = await query(`
            SELECT COUNT(*) as c 
            FROM ateliers a 
            INNER JOIN planning p ON a.id = p.atelier_id 
            INNER JOIN creneaux c ON p.creneau_id = c.id 
            WHERE a.statut = 'valide'
        `);
        
        console.log(`[ELEVES DEBUG]`);
        console.log(`  - Ateliers validés: ${debug1[0].c}`);
        console.log(`  - Planning entries: ${debug2[0].c}`);
        console.log(`  - Ateliers+Planning JOIN: ${debug3[0].c}`);
        console.log(`  - Creneaux total: ${debug4[0].c}`);
        console.log(`  - Ateliers+Planning+Creneaux JOIN: ${debug5[0].c}`);
        
        // Récupérer tous les ateliers placés dans le planning avec leurs créneaux
        const ateliers = await query(`
            SELECT 
                a.id as atelier_id,
                a.nom,
                a.description,
                a.duree,
                a.nombre_places_max,
                a.informations_eleves,
                a.enseignant_acronyme,
                t.nom as theme_nom,
                t.couleur as theme_couleur,
                t.icone as theme_icone,
                COALESCE(u.nom, a.enseignant_acronyme) as enseignant_nom,
                COALESCE(u.prenom, '') as enseignant_prenom,
                p.id as planning_id,
                p.creneau_id,
                p.nombre_creneaux,
                c.jour,
                c.periode,
                c.ordre as creneau_ordre,
                s.nom as salle_nom,
                (SELECT COUNT(*) FROM inscriptions WHERE planning_id = p.id AND statut = 'confirmee') as nb_inscrits
            FROM ateliers a
            INNER JOIN planning p ON a.id = p.atelier_id
            INNER JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            LEFT JOIN salles s ON p.salle_id = s.id
            LEFT JOIN themes t ON a.theme_id = t.id
            WHERE a.statut = 'valide'
            ORDER BY c.ordre, a.nom
        `);
        
        console.log(`  - Final result: ${ateliers.length} ateliers`);
        
        // Enrichir chaque atelier avec les infos de disponibilité
        const ateliersEnrichis = ateliers.map(a => {
            const placesQuota = Math.ceil(a.nombre_places_max * quotaPourcent / 100);
            const placesRestantes = Math.max(0, placesQuota - a.nb_inscrits);
            const complet = placesRestantes <= 0;
            
            // Vérifier si conflit horaire pour cet élève
            let conflit = false;
            for (let i = 0; i < a.nombre_creneaux; i++) {
                if (creneauxOccupes.has(a.creneau_id + i)) {
                    conflit = true;
                    break;
                }
            }
            
            // Vérifier si déjà inscrit à cet atelier (sur n'importe quel créneau)
            const dejaInscrit = inscriptionsEleve.some(insc => {
                // Chercher si l'élève est inscrit à ce planning_id ou à cet atelier
                return false; // On vérifiera plus précisément
            });
            
            return {
                ...a,
                places_quota: placesQuota,
                places_restantes: placesRestantes,
                complet: complet,
                conflit_horaire: conflit,
                inscriptible: inscriptionsOuvertes && !complet && !conflit
            };
        });
        
        res.json({
            success: true,
            inscriptions_ouvertes: inscriptionsOuvertes,
            quota_pourcent: quotaPourcent,
            data: ateliersEnrichis,
            eleve_info: {
                id: eleve.id,
                classe: eleve.classe_nom
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
                s.nom as salle_nom
            FROM inscriptions i
            JOIN ateliers a ON i.atelier_id = a.id
            JOIN planning p ON i.planning_id = p.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            WHERE i.eleve_id = ? AND i.statut = 'confirmee'
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
 * S'inscrire à un atelier (avec verrouillage transactionnel)
 */
router.post('/inscrire/:planningId', async (req, res) => {
    try {
        const { planningId } = req.params;
        const eleveUserId = req.user.id;
        
        // Utiliser une transaction avec verrouillage pour éviter les inscriptions simultanées
        const result = await transaction(async (connection) => {
            // Récupérer l'élève et sa classe
            const [eleves] = await connection.execute(`
                SELECT e.*, c.nom as classe_nom, c.inscriptions_ouvertes
                FROM eleves e
                JOIN classes c ON e.classe_id = c.id
                WHERE e.utilisateur_id = ?
            `, [eleveUserId]);
            
            if (eleves.length === 0) {
                throw new Error('Élève non trouvé');
            }
            
            const eleve = eleves[0];
            
            // Vérifier que les inscriptions sont ouvertes pour cette classe
            if (!eleve.inscriptions_ouvertes) {
                throw new Error('Les inscriptions ne sont pas ouvertes pour ta classe');
            }
            
            // Récupérer les infos du planning AVEC VERROUILLAGE
            const [plannings] = await connection.execute(`
                SELECT p.*, a.nombre_places_max, a.id as atelier_id, a.nom as atelier_nom, a.duree
                FROM planning p
                JOIN ateliers a ON p.atelier_id = a.id
                WHERE p.id = ?
                FOR UPDATE
            `, [planningId]);
            
            if (plannings.length === 0) {
                throw new Error('Atelier non trouvé dans le planning');
            }
            
            const planning = plannings[0];
            
            // Récupérer le quota
            const [quotaConfig] = await connection.execute(`
                SELECT valeur FROM configuration WHERE cle = 'quota_places_pourcent'
            `);
            const quotaPourcent = parseFloat(quotaConfig[0]?.valeur || 100);
            const placesQuota = Math.ceil(planning.nombre_places_max * quotaPourcent / 100);
            
            // Compter les inscrits actuels (avec verrou)
            const [inscrits] = await connection.execute(`
                SELECT COUNT(*) as count
                FROM inscriptions
                WHERE planning_id = ? AND statut = 'confirmee'
            `, [planningId]);
            
            if (inscrits[0].count >= placesQuota) {
                throw new Error('Atelier complet, plus de places disponibles');
            }
            
            // Vérifier que l'élève n'est pas déjà inscrit à cet atelier (sur ce créneau)
            const [dejaInscrit] = await connection.execute(`
                SELECT id FROM inscriptions
                WHERE eleve_id = ? AND planning_id = ? AND statut = 'confirmee'
            `, [eleve.id, planningId]);
            
            if (dejaInscrit.length > 0) {
                throw new Error('Tu es déjà inscrit à cet atelier sur ce créneau');
            }
            
            // Vérifier les conflits horaires
            // Calculer les créneaux couverts par ce nouvel atelier
            const creneauxCouverts = [];
            for (let i = 0; i < planning.nombre_creneaux; i++) {
                creneauxCouverts.push(planning.creneau_id + i);
            }
            
            // Vérifier si l'élève a déjà un atelier sur l'un de ces créneaux
            const [conflits] = await connection.execute(`
                SELECT DISTINCT a.nom as atelier_nom
                FROM inscriptions i
                JOIN planning p ON i.planning_id = p.id
                JOIN ateliers a ON p.atelier_id = a.id
                WHERE i.eleve_id = ? 
                AND i.statut = 'confirmee'
                AND (
                    ${creneauxCouverts.map(c => `(p.creneau_id <= ${c} AND p.creneau_id + p.nombre_creneaux > ${c})`).join(' OR ')}
                )
            `, [eleve.id]);
            
            if (conflits.length > 0) {
                throw new Error(`Conflit horaire avec "${conflits[0].atelier_nom}"`);
            }
            
            // Tout est OK, créer l'inscription
            const [insertResult] = await connection.execute(`
                INSERT INTO inscriptions (eleve_id, atelier_id, planning_id, statut, date_inscription)
                VALUES (?, ?, ?, 'confirmee', NOW())
            `, [eleve.id, planning.atelier_id, planningId]);
            
            return {
                inscriptionId: insertResult.insertId,
                atelierNom: planning.atelier_nom
            };
        });
        
        res.json({
            success: true,
            message: `Inscription confirmée pour "${result.atelierNom}"`,
            data: { inscription_id: result.inscriptionId }
        });
        
    } catch (error) {
        console.error('Erreur inscription:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Erreur lors de l\'inscription'
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
            SELECT e.*, c.inscriptions_ouvertes
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
        if (!eleve.inscriptions_ouvertes) {
            return res.status(403).json({
                success: false,
                message: 'Les modifications ne sont pas autorisées'
            });
        }
        
        // Vérifier que l'inscription appartient à cet élève
        const inscriptions = await query(`
            SELECT i.*, a.nom as atelier_nom
            FROM inscriptions i
            JOIN ateliers a ON i.atelier_id = a.id
            WHERE i.id = ? AND i.eleve_id = ?
        `, [inscriptionId, eleve.id]);
        
        if (inscriptions.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Inscription non trouvée'
            });
        }
        
        // Supprimer l'inscription (ou marquer comme annulée)
        await query(`
            UPDATE inscriptions SET statut = 'annulee' WHERE id = ?
        `, [inscriptionId]);
        
        res.json({
            success: true,
            message: `Désinscription de "${inscriptions[0].atelier_nom}" effectuée`
        });
        
    } catch (error) {
        console.error('Erreur désinscription:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la désinscription'
        });
    }
});

/**
 * GET /api/eleves/creneaux
 * Liste des créneaux pour l'affichage de l'horaire
 */
router.get('/creneaux', async (req, res) => {
    try {
        const creneaux = await query(`
            SELECT * FROM creneaux ORDER BY ordre
        `);
        
        res.json({
            success: true,
            data: creneaux
        });
    } catch (error) {
        console.error('Erreur créneaux:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

module.exports = router;
