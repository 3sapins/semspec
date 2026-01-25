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
        
        // Statistiques des ateliers de l'enseignant
        const ateliers = await query(`
            SELECT 
                statut,
                COUNT(*) as count,
                SUM(budget_max) as budget_total
            FROM ateliers 
            WHERE enseignant_acronyme = ?
            GROUP BY statut
        `, [acronyme]);
        
        // Total des inscriptions à ses ateliers
        const inscriptions = await query(`
            SELECT COUNT(DISTINCT i.id) as total
            FROM inscriptions i
            JOIN ateliers a ON i.atelier_id = a.id
            WHERE a.enseignant_acronyme = ? AND i.statut = 'confirmee'
        `, [acronyme]);
        
        // Disponibilités déclarées
        const disponibilites = await query(`
            SELECT COUNT(*) as count
            FROM disponibilites_enseignants
            WHERE enseignant_acronyme = ? AND disponible = TRUE
        `, [acronyme]);
        
        res.json({
            success: true,
            data: {
                ateliers: ateliers,
                inscriptions_total: inscriptions[0]?.total || 0,
                disponibilites_declarees: disponibilites[0]?.count || 0,
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
 * GET /api/enseignants/ateliers
 * Liste des ateliers de l'enseignant
 */
router.get('/ateliers', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        
        const ateliers = await query(`
            SELECT 
                a.*,
                COUNT(DISTINCT i.id) as nombre_inscrits,
                (a.nombre_places_max - COUNT(DISTINCT i.id)) as places_restantes
            FROM ateliers a
            LEFT JOIN inscriptions i ON a.id = i.atelier_id AND i.statut = 'confirmee'
            WHERE a.enseignant_acronyme = ?
            GROUP BY a.id
            ORDER BY a.date_creation DESC
        `, [acronyme]);
        
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
                COUNT(DISTINCT i.id) as nombre_inscrits
            FROM ateliers a
            LEFT JOIN inscriptions i ON a.id = i.atelier_id AND i.statut = 'confirmee'
            WHERE a.id = ? AND a.enseignant_acronyme = ?
            GROUP BY a.id
        `, [id, acronyme]);
        
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
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'CREATE', 'ateliers', result.insertId, `Atelier "${nom}" créé`]
        );
        
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
            'SELECT * FROM ateliers WHERE id = ? AND enseignant_acronyme = ?',
            [id, acronyme]
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
                message: 'Impossible de modifier un atelier déjà soumis ou validé'
            });
        }
        
        // Mise à jour
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
            nom || atelier.nom,
            description !== undefined ? description : atelier.description,
            duree || atelier.duree,
            nombre_places_max || atelier.nombre_places_max,
            budget_max !== undefined ? budget_max : atelier.budget_max,
            type_salle_demande !== undefined ? type_salle_demande : atelier.type_salle_demande,
            remarques !== undefined ? remarques : atelier.remarques,
            informations_eleves !== undefined ? informations_eleves : atelier.informations_eleves,
            id
        ]);
        
        // Log
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'UPDATE', 'ateliers', id, `Atelier "${nom || atelier.nom}" modifié`]
        );
        
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
        
        // Vérifier que l'atelier appartient à l'enseignant et est en brouillon
        const ateliers = await query(
            'SELECT * FROM ateliers WHERE id = ? AND enseignant_acronyme = ? AND statut = "brouillon"',
            [id, acronyme]
        );
        
        if (ateliers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Atelier non trouvé ou impossible à supprimer'
            });
        }
        
        await query('DELETE FROM ateliers WHERE id = ?', [id]);
        
        // Log
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'DELETE', 'ateliers', id, `Atelier "${ateliers[0].nom}" supprimé`]
        );
        
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
        
        // Vérifier que l'atelier appartient à l'enseignant et est en brouillon
        const ateliers = await query(
            'SELECT * FROM ateliers WHERE id = ? AND enseignant_acronyme = ? AND statut = "brouillon"',
            [id, acronyme]
        );
        
        if (ateliers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Atelier non trouvé ou déjà soumis'
            });
        }
        
        // Changer le statut à "soumis"
        await query(
            'UPDATE ateliers SET statut = "soumis" WHERE id = ?',
            [id]
        );
        
        // Log
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'SUBMIT', 'ateliers', id, `Atelier "${ateliers[0].nom}" soumis pour validation`]
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
        
        // Créer un map pour faciliter l'accès
        const dispoMap = {};
        disponibilites.forEach(d => {
            dispoMap[d.creneau_id] = d;
        });
        
        // Construire la réponse avec tous les créneaux
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
            data: result
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
        
        // disponibilites est un tableau d'objets: [{creneau_id, disponible, periodes_enseignees_normalement}]
        
        if (!Array.isArray(disponibilites)) {
            return res.status(400).json({
                success: false,
                message: 'Format de données invalide'
            });
        }
        
        // Utiliser une transaction pour tout mettre à jour
        await transaction(async (connection) => {
            // Supprimer les anciennes disponibilités
            await connection.execute(
                'DELETE FROM disponibilites_enseignants WHERE enseignant_acronyme = ?',
                [acronyme]
            );
            
            // Insérer les nouvelles
            for (const dispo of disponibilites) {
                await connection.execute(`
                    INSERT INTO disponibilites_enseignants 
                    (enseignant_acronyme, creneau_id, disponible, periodes_enseignees_normalement)
                    VALUES (?, ?, ?, ?)
                `, [
                    acronyme,
                    dispo.creneau_id,
                    dispo.disponible || false,
                    dispo.periodes_enseignees_normalement || 0
                ]);
            }
        });
        
        // Log
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'UPDATE_DISPONIBILITES', `Disponibilités mises à jour pour ${acronyme}`]
        );
        
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

module.exports = router;
