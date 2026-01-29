const express = require('express');
const router = express.Router();
const { query, transaction } = require('../config/database');
const { authMiddleware, enseignantMiddleware } = require('../middleware/auth');

// Protection: toutes les routes nécessitent authentification enseignant
router.use(authMiddleware, enseignantMiddleware);

/**
 * GET /api/enseignants/dashboard
 * Récupération des statistiques personnelles de l'enseignant
 */
router.get('/dashboard', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        
        // Statistiques des ateliers de l'enseignant (principal + co-animateur)
        const ateliers = await query(`
            SELECT 
                statut,
                COUNT(*) as count,
                COALESCE(SUM(budget_max), 0) as budget_total
            FROM ateliers 
            WHERE enseignant_acronyme = ? 
               OR enseignant2_acronyme = ? 
               OR enseignant3_acronyme = ?
            GROUP BY statut
        `, [acronyme, acronyme, acronyme]);
        
        // Total des inscriptions à ses ateliers
        const inscriptions = await query(`
            SELECT COUNT(DISTINCT i.id) as total
            FROM inscriptions i
            JOIN planning p ON i.planning_id = p.id
            JOIN ateliers a ON p.atelier_id = a.id
            WHERE (a.enseignant_acronyme = ? 
                   OR a.enseignant2_acronyme = ? 
                   OR a.enseignant3_acronyme = ?)
            AND i.statut = 'confirmee'
        `, [acronyme, acronyme, acronyme]);
        
        // Disponibilités déclarées
        const disponibilites = await query(`
            SELECT COUNT(*) as count
            FROM disponibilites_enseignants
            WHERE enseignant_acronyme = ? AND disponible = TRUE
        `, [acronyme]);
        
        // Vérifier si les disponibilités sont validées
        const validation = await query(`
            SELECT valide FROM disponibilites_enseignants 
            WHERE enseignant_acronyme = ? 
            LIMIT 1
        `, [acronyme]);
        
        res.json({
            success: true,
            data: {
                ateliers: ateliers,
                inscriptions_total: inscriptions[0]?.total || 0,
                disponibilites_declarees: disponibilites[0]?.count || 0,
                disponibilites_validees: validation[0]?.valide || false,
                creneaux_total: 14
            }
        });
        
    } catch (error) {
        console.error('Erreur dashboard enseignant:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération des statistiques'
        });
    }
});

/**
 * GET /api/enseignants/mon-horaire
 * Horaire complet de l'enseignant avec nb inscrits par créneau
 */
router.get('/mon-horaire', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        
        // Récupérer l'horaire de l'enseignant
        const horaire = await query(`
            SELECT 
                p.id as planning_id,
                p.creneau_id,
                p.nombre_creneaux,
                a.id as atelier_id,
                a.nom as atelier_nom,
                a.duree,
                a.nombre_places_max,
                c.jour,
                c.periode,
                c.ordre,
                s.nom as salle_nom,
                (SELECT COUNT(*) FROM inscriptions 
                 WHERE planning_id = p.id AND statut = 'confirmee') as nb_inscrits
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            WHERE (a.enseignant_acronyme = ? 
                   OR a.enseignant2_acronyme = ? 
                   OR a.enseignant3_acronyme = ?)
            AND a.statut = 'valide'
            ORDER BY c.ordre
        `, [acronyme, acronyme, acronyme]);
        
        // Récupérer tous les créneaux pour la grille
        const creneaux = await query('SELECT * FROM creneaux ORDER BY ordre');
        
        res.json({
            success: true,
            data: {
                ateliers: horaire,
                creneaux: creneaux
            }
        });
        
    } catch (error) {
        console.error('Erreur horaire enseignant:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération de l\'horaire'
        });
    }
});

/**
 * GET /api/enseignants/listes/:planningId
 * Liste des élèves inscrits à un créneau spécifique
 */
router.get('/listes/:planningId', async (req, res) => {
    try {
        const { planningId } = req.params;
        const acronyme = req.user.acronyme;
        
        // Vérifier que c'est un atelier de l'enseignant
        const planning = await query(`
            SELECT p.id, p.creneau_id, a.id as atelier_id, a.nom, a.nombre_places_max,
                   c.jour, c.periode, s.nom as salle_nom
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            WHERE p.id = ?
            AND (a.enseignant_acronyme = ? 
                 OR a.enseignant2_acronyme = ? 
                 OR a.enseignant3_acronyme = ?)
        `, [planningId, acronyme, acronyme, acronyme]);
        
        if (planning.length === 0) {
            return res.status(403).json({
                success: false,
                message: 'Accès non autorisé à cet atelier'
            });
        }
        
        // Récupérer les élèves inscrits
        const eleves = await query(`
            SELECT 
                i.id as inscription_id,
                e.id as eleve_id,
                u.nom,
                u.prenom,
                cl.nom as classe_nom,
                i.statut,
                i.inscription_manuelle
            FROM inscriptions i
            JOIN eleves e ON i.eleve_id = e.id
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes cl ON e.classe_id = cl.id
            WHERE i.planning_id = ? AND i.statut = 'confirmee'
            ORDER BY cl.nom, u.nom, u.prenom
        `, [planningId]);
        
        res.json({
            success: true,
            data: {
                planning: planning[0],
                eleves: eleves,
                total: eleves.length
            }
        });
        
    } catch (error) {
        console.error('Erreur liste élèves:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération de la liste'
        });
    }
});

/**
 * GET /api/enseignants/catalogue
 * Catalogue de tous les ateliers validés (avec noms enseignants)
 */
router.get('/catalogue', async (req, res) => {
    try {
        const ateliers = await query(`
            SELECT 
                a.id,
                a.nom,
                a.description,
                a.duree,
                a.nombre_places_max,
                a.informations_eleves,
                a.enseignant_acronyme,
                a.enseignant2_acronyme,
                a.enseignant3_acronyme,
                CONCAT_WS(', ',
                    (SELECT CONCAT(prenom, ' ', nom) FROM utilisateurs WHERE acronyme = a.enseignant_acronyme),
                    (SELECT CONCAT(prenom, ' ', nom) FROM utilisateurs WHERE acronyme = a.enseignant2_acronyme),
                    (SELECT CONCAT(prenom, ' ', nom) FROM utilisateurs WHERE acronyme = a.enseignant3_acronyme)
                ) as enseignants_noms,
                t.nom as theme_nom,
                t.couleur as theme_couleur,
                t.icone as theme_icone
            FROM ateliers a
            LEFT JOIN themes t ON a.theme_id = t.id
            WHERE a.statut = 'valide'
            ORDER BY a.nom
        `);
        
        // Pour chaque atelier, récupérer les créneaux
        for (const atelier of ateliers) {
            const creneaux = await query(`
                SELECT 
                    p.id as planning_id,
                    c.jour,
                    c.periode,
                    s.nom as salle_nom,
                    (SELECT COUNT(*) FROM inscriptions WHERE planning_id = p.id AND statut = 'confirmee') as nb_inscrits
                FROM planning p
                JOIN creneaux c ON p.creneau_id = c.id
                LEFT JOIN salles s ON p.salle_id = s.id
                WHERE p.atelier_id = ?
                ORDER BY c.ordre
            `, [atelier.id]);
            atelier.creneaux = creneaux;
        }
        
        res.json({
            success: true,
            data: ateliers
        });
        
    } catch (error) {
        console.error('Erreur catalogue:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération du catalogue'
        });
    }
});

/**
 * GET /api/enseignants/themes
 * Liste des thèmes pour filtrage
 */
router.get('/themes', async (req, res) => {
    try {
        const themes = await query('SELECT * FROM themes ORDER BY nom');
        res.json({ success: true, data: themes });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/enseignants/ateliers
 * Liste des ateliers de l'enseignant
 */
router.get('/ateliers', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        
        const ateliers = await query(`
            SELECT 
                a.*,
                (SELECT COUNT(*) FROM inscriptions i 
                 JOIN planning p ON i.planning_id = p.id 
                 WHERE p.atelier_id = a.id AND i.statut = 'confirmee') as nombre_inscrits
            FROM ateliers a
            WHERE a.enseignant_acronyme = ?
               OR a.enseignant2_acronyme = ?
               OR a.enseignant3_acronyme = ?
            ORDER BY a.date_creation DESC
        `, [acronyme, acronyme, acronyme]);
        
        res.json({
            success: true,
            data: ateliers
        });
        
    } catch (error) {
        console.error('Erreur liste ateliers:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération des ateliers'
        });
    }
});

/**
 * GET /api/enseignants/ateliers/:id
 * Détails d'un atelier spécifique
 */
router.get('/ateliers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const acronyme = req.user.acronyme;
        
        const ateliers = await query(`
            SELECT a.*,
                (SELECT COUNT(*) FROM inscriptions i 
                 JOIN planning p ON i.planning_id = p.id 
                 WHERE p.atelier_id = a.id AND i.statut = 'confirmee') as nombre_inscrits
            FROM ateliers a
            WHERE a.id = ? 
            AND (a.enseignant_acronyme = ? 
                 OR a.enseignant2_acronyme = ? 
                 OR a.enseignant3_acronyme = ?)
        `, [id, acronyme, acronyme, acronyme]);
        
        if (ateliers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Atelier non trouvé'
            });
        }
        
        // Récupérer les classes obligatoires si c'est un atelier obligatoire
        if (ateliers[0].obligatoire) {
            const classes = await query(`
                SELECT c.nom
                FROM ateliers_obligatoires ao
                JOIN classes c ON ao.classe_id = c.id
                WHERE ao.atelier_id = ?
            `, [id]);
            
            ateliers[0].classes_obligatoires = classes.map(c => c.nom);
        }
        
        res.json({
            success: true,
            data: ateliers[0]
        });
        
    } catch (error) {
        console.error('Erreur détails atelier:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération des détails'
        });
    }
});

/**
 * POST /api/enseignants/ateliers
 * Création d'un nouvel atelier
 */
router.post('/ateliers', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        const {
            nom,
            description,
            duree,
            nombre_places_max,
            budget_max,
            type_salle_demande,
            remarques,
            informations_eleves
        } = req.body;
        
        // Validation
        if (!nom || !duree || !nombre_places_max) {
            return res.status(400).json({
                success: false,
                message: 'Nom, durée et nombre de places requis'
            });
        }
        
        if (![2, 4, 6].includes(parseInt(duree))) {
            return res.status(400).json({
                success: false,
                message: 'Durée doit être 2, 4 ou 6 périodes'
            });
        }
        
        const result = await query(`
            INSERT INTO ateliers (
                nom, description, enseignant_acronyme, duree, 
                nombre_places_max, budget_max, type_salle_demande, 
                remarques, informations_eleves, statut
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'brouillon')
        `, [
            nom,
            description || null,
            acronyme,
            duree,
            nombre_places_max,
            budget_max || 0,
            type_salle_demande || null,
            remarques || null,
            informations_eleves || null
        ]);
        
        // Log
        try {
            await query(
                'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
                [req.user.id, 'CREATE', 'ateliers', result.insertId, `Atelier "${nom}" créé`]
            );
        } catch (e) {}
        
        res.json({
            success: true,
            message: 'Atelier créé avec succès',
            data: {
                id: result.insertId
            }
        });
        
    } catch (error) {
        console.error('Erreur création atelier:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la création de l\'atelier'
        });
    }
});

/**
 * PUT /api/enseignants/ateliers/:id
 * Modification d'un atelier (seulement si brouillon ou refusé)
 */
router.put('/ateliers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const acronyme = req.user.acronyme;
        const {
            nom,
            description,
            duree,
            nombre_places_max,
            budget_max,
            type_salle_demande,
            remarques,
            informations_eleves
        } = req.body;
        
        // Vérifier que l'atelier appartient à l'enseignant
        const ateliers = await query(
            `SELECT * FROM ateliers WHERE id = ? 
             AND (enseignant_acronyme = ? OR enseignant2_acronyme = ? OR enseignant3_acronyme = ?)`,
            [id, acronyme, acronyme, acronyme]
        );
        
        if (ateliers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Atelier non trouvé'
            });
        }
        
        const atelier = ateliers[0];
        
        // Vérifier qu'on peut modifier (brouillon ou refusé)
        if (!['brouillon', 'refuse'].includes(atelier.statut)) {
            return res.status(403).json({
                success: false,
                message: 'Cet atelier ne peut plus être modifié'
            });
        }
        
        await query(`
            UPDATE ateliers SET
                nom = ?,
                description = ?,
                duree = ?,
                nombre_places_max = ?,
                budget_max = ?,
                type_salle_demande = ?,
                remarques = ?,
                informations_eleves = ?
            WHERE id = ?
        `, [
            nom !== undefined ? nom : atelier.nom,
            description !== undefined ? description : atelier.description,
            duree !== undefined ? duree : atelier.duree,
            nombre_places_max !== undefined ? nombre_places_max : atelier.nombre_places_max,
            budget_max !== undefined ? budget_max : atelier.budget_max,
            type_salle_demande !== undefined ? type_salle_demande : atelier.type_salle_demande,
            remarques !== undefined ? remarques : atelier.remarques,
            informations_eleves !== undefined ? informations_eleves : atelier.informations_eleves,
            id
        ]);
        
        res.json({
            success: true,
            message: 'Atelier modifié avec succès'
        });
        
    } catch (error) {
        console.error('Erreur modification atelier:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la modification de l\'atelier'
        });
    }
});

/**
 * DELETE /api/enseignants/ateliers/:id
 * Suppression d'un atelier (seulement si brouillon)
 */
router.delete('/ateliers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const acronyme = req.user.acronyme;
        
        const ateliers = await query(
            `SELECT * FROM ateliers WHERE id = ? AND enseignant_acronyme = ? AND statut = 'brouillon'`,
            [id, acronyme]
        );
        
        if (ateliers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Atelier non trouvé ou impossible à supprimer'
            });
        }
        
        await query('DELETE FROM ateliers WHERE id = ?', [id]);
        
        res.json({
            success: true,
            message: 'Atelier supprimé avec succès'
        });
        
    } catch (error) {
        console.error('Erreur suppression atelier:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la suppression de l\'atelier'
        });
    }
});

/**
 * POST /api/enseignants/ateliers/:id/soumettre
 * Soumettre un atelier pour validation
 */
router.post('/ateliers/:id/soumettre', async (req, res) => {
    try {
        const { id } = req.params;
        const acronyme = req.user.acronyme;
        
        const ateliers = await query(
            `SELECT * FROM ateliers WHERE id = ? AND enseignant_acronyme = ? AND statut = 'brouillon'`,
            [id, acronyme]
        );
        
        if (ateliers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Atelier non trouvé ou déjà soumis'
            });
        }
        
        await query(
            'UPDATE ateliers SET statut = "soumis" WHERE id = ?',
            [id]
        );
        
        res.json({
            success: true,
            message: 'Atelier soumis pour validation'
        });
        
    } catch (error) {
        console.error('Erreur soumission atelier:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la soumission de l\'atelier'
        });
    }
});

/**
 * GET /api/enseignants/disponibilites
 * Récupération des disponibilités de l'enseignant
 */
router.get('/disponibilites', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        
        // Récupérer tous les créneaux
        const creneaux = await query('SELECT * FROM creneaux ORDER BY ordre');
        
        // Récupérer les disponibilités de l'enseignant
        const disponibilites = await query(
            'SELECT * FROM disponibilites_enseignants WHERE enseignant_acronyme = ?',
            [acronyme]
        );
        
        // Vérifier si validées
        const validation = disponibilites.length > 0 ? disponibilites[0].valide : false;
        
        // Créer un map
        const dispoMap = {};
        disponibilites.forEach(d => {
            dispoMap[d.creneau_id] = d;
        });
        
        // Construire la réponse
        const result = creneaux.map(c => ({
            creneau_id: c.id,
            jour: c.jour,
            periode: c.periode,
            heure_debut: c.heure_debut,
            heure_fin: c.heure_fin,
            ordre: c.ordre,
            disponible: dispoMap[c.id]?.disponible || false,
            periodes_enseignees_normalement: dispoMap[c.id]?.periodes_enseignees_normalement || 0
        }));
        
        res.json({
            success: true,
            data: result,
            valide: validation
        });
        
    } catch (error) {
        console.error('Erreur disponibilités:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération des disponibilités'
        });
    }
});

/**
 * PUT /api/enseignants/disponibilites
 * Mise à jour des disponibilités de l'enseignant
 */
router.put('/disponibilites', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        const { disponibilites } = req.body;
        
        if (!Array.isArray(disponibilites)) {
            return res.status(400).json({
                success: false,
                message: 'Format de données invalide'
            });
        }
        
        // Vérifier si les disponibilités sont déjà validées
        const existantes = await query(
            'SELECT valide FROM disponibilites_enseignants WHERE enseignant_acronyme = ? LIMIT 1',
            [acronyme]
        );
        
        if (existantes.length > 0 && existantes[0].valide) {
            return res.status(403).json({
                success: false,
                message: 'Vos disponibilités ont été validées et ne peuvent plus être modifiées'
            });
        }
        
        await transaction(async (connection) => {
            await connection.execute(
                'DELETE FROM disponibilites_enseignants WHERE enseignant_acronyme = ?',
                [acronyme]
            );
            
            for (const dispo of disponibilites) {
                await connection.execute(`
                    INSERT INTO disponibilites_enseignants 
                    (enseignant_acronyme, creneau_id, disponible, periodes_enseignees_normalement, valide)
                    VALUES (?, ?, ?, ?, FALSE)
                `, [
                    acronyme,
                    dispo.creneau_id,
                    dispo.disponible || false,
                    dispo.periodes_enseignees_normalement || 0
                ]);
            }
        });
        
        res.json({
            success: true,
            message: 'Disponibilités mises à jour avec succès'
        });
        
    } catch (error) {
        console.error('Erreur mise à jour disponibilités:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la mise à jour des disponibilités'
        });
    }
});

/**
 * GET /api/enseignants/types-salles
 * Liste des types de salles disponibles
 */
router.get('/types-salles', async (req, res) => {
    try {
        const types = await query(`
            SELECT DISTINCT type_salle 
            FROM salles 
            WHERE type_salle IS NOT NULL AND disponible = TRUE
            ORDER BY type_salle
        `);
        
        res.json({
            success: true,
            data: types.map(t => t.type_salle)
        });
        
    } catch (error) {
        console.error('Erreur types salles:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération des types de salles'
        });
    }
});

/**
 * GET /api/enseignants/impression/horaire
 * Données pour impression de l'horaire
 */
router.get('/impression/horaire', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        
        // Infos enseignant
        const enseignant = await query(
            'SELECT nom, prenom FROM utilisateurs WHERE acronyme = ?',
            [acronyme]
        );
        
        // Horaire
        const horaire = await query(`
            SELECT 
                p.id as planning_id,
                p.creneau_id,
                a.nom as atelier_nom,
                a.nombre_places_max,
                c.jour,
                c.periode,
                c.ordre,
                s.nom as salle_nom,
                (SELECT COUNT(*) FROM inscriptions 
                 WHERE planning_id = p.id AND statut = 'confirmee') as nb_inscrits
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            WHERE (a.enseignant_acronyme = ? 
                   OR a.enseignant2_acronyme = ? 
                   OR a.enseignant3_acronyme = ?)
            AND a.statut = 'valide'
            ORDER BY c.ordre
        `, [acronyme, acronyme, acronyme]);
        
        const creneaux = await query('SELECT * FROM creneaux ORDER BY ordre');
        
        res.json({
            success: true,
            data: {
                enseignant: enseignant[0] || { nom: acronyme, prenom: '' },
                horaire,
                creneaux
            }
        });
        
    } catch (error) {
        console.error('Erreur impression horaire:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/enseignants/impression/listes
 * Toutes les listes de l'enseignant pour impression
 */
router.get('/impression/listes', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        
        // Infos enseignant
        const enseignant = await query(
            'SELECT nom, prenom FROM utilisateurs WHERE acronyme = ?',
            [acronyme]
        );
        
        // Récupérer tous les plannings de l'enseignant
        const plannings = await query(`
            SELECT 
                p.id as planning_id,
                a.nom as atelier_nom,
                a.nombre_places_max,
                c.jour,
                c.periode,
                s.nom as salle_nom
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            WHERE (a.enseignant_acronyme = ? 
                   OR a.enseignant2_acronyme = ? 
                   OR a.enseignant3_acronyme = ?)
            AND a.statut = 'valide'
            ORDER BY c.ordre
        `, [acronyme, acronyme, acronyme]);
        
        // Pour chaque planning, récupérer les élèves
        const listes = [];
        for (const p of plannings) {
            const eleves = await query(`
                SELECT 
                    u.nom, u.prenom,
                    cl.nom as classe_nom
                FROM inscriptions i
                JOIN eleves e ON i.eleve_id = e.id
                JOIN utilisateurs u ON e.utilisateur_id = u.id
                JOIN classes cl ON e.classe_id = cl.id
                WHERE i.planning_id = ? AND i.statut = 'confirmee'
                ORDER BY cl.nom, u.nom, u.prenom
            `, [p.planning_id]);
            
            listes.push({
                ...p,
                eleves,
                total: eleves.length
            });
        }
        
        res.json({
            success: true,
            data: {
                enseignant: enseignant[0] || { nom: acronyme, prenom: '' },
                listes
            }
        });
        
    } catch (error) {
        console.error('Erreur impression listes:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

module.exports = router;
