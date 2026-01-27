const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

/**
 * GET /api/catalogue
 * Liste publique des ateliers avec leurs thèmes et créneaux
 * Accessible à tous (élèves, enseignants, admin)
 */
router.get('/', async (req, res) => {
    try {
        // Récupérer les thèmes actifs
        const themes = await query(`
            SELECT id, nom, description, couleur, icone, ordre
            FROM themes
            WHERE actif = TRUE
            ORDER BY ordre, nom
        `);
        
        // Récupérer les ateliers validés avec leurs créneaux
        const ateliers = await query(`
            SELECT 
                a.id,
                a.nom,
                a.description,
                a.theme_id,
                a.duree,
                a.nombre_places_max,
                a.informations_eleves,
                a.enseignant_acronyme,
                a.enseignant2_acronyme,
                a.enseignant3_acronyme,
                a.budget_max,
                a.obligatoire,
                t.nom as theme_nom,
                t.couleur as theme_couleur,
                t.icone as theme_icone,
                (SELECT COUNT(*) FROM inscriptions WHERE atelier_id = a.id) as nb_inscrits
            FROM ateliers a
            LEFT JOIN themes t ON a.theme_id = t.id
            WHERE a.statut = 'valide'
            ORDER BY t.ordre, t.nom, a.nom
        `);
        
        // Récupérer les créneaux pour chaque atelier
        const creneaux = await query(`
            SELECT 
                p.atelier_id,
                c.jour,
                c.periode,
                c.ordre,
                s.nom as salle
            FROM planning p
            JOIN creneaux c ON p.creneau_id = c.id
            JOIN salles s ON p.salle_id = s.id
            JOIN ateliers a ON p.atelier_id = a.id
            WHERE a.statut = 'valide'
            ORDER BY c.ordre
        `);
        
        // Associer les créneaux aux ateliers
        const creneauxParAtelier = {};
        creneaux.forEach(c => {
            if (!creneauxParAtelier[c.atelier_id]) {
                creneauxParAtelier[c.atelier_id] = [];
            }
            creneauxParAtelier[c.atelier_id].push({
                jour: c.jour,
                periode: c.periode,
                salle: c.salle
            });
        });
        
        // Ajouter les créneaux à chaque atelier
        ateliers.forEach(a => {
            a.creneaux = creneauxParAtelier[a.id] || [];
        });
        
        res.json({
            success: true,
            data: {
                themes,
                ateliers
            }
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
 * GET /api/catalogue/themes
 * Liste des thèmes uniquement
 */
router.get('/themes', async (req, res) => {
    try {
        const themes = await query(`
            SELECT id, nom, description, couleur, icone, ordre
            FROM themes
            WHERE actif = TRUE
            ORDER BY ordre, nom
        `);
        
        res.json({ success: true, data: themes });
    } catch (error) {
        console.error('Erreur themes:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ============================================================
// ROUTES ADMIN POUR GESTION DES THÈMES
// ============================================================

/**
 * GET /api/catalogue/admin/themes
 * Liste complète des thèmes (admin)
 */
router.get('/admin/themes', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const themes = await query(`
            SELECT 
                t.*,
                (SELECT COUNT(*) FROM ateliers WHERE theme_id = t.id AND statut = 'valide') as nb_ateliers
            FROM themes t
            ORDER BY t.ordre, t.nom
        `);
        
        res.json({ success: true, data: themes });
    } catch (error) {
        console.error('Erreur admin themes:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/catalogue/admin/themes
 * Créer un nouveau thème
 */
router.post('/admin/themes', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { nom, description, couleur, icone, ordre } = req.body;
        
        if (!nom) {
            return res.status(400).json({
                success: false,
                message: 'Nom du thème requis'
            });
        }
        
        const result = await query(`
            INSERT INTO themes (nom, description, couleur, icone, ordre)
            VALUES (?, ?, ?, ?, ?)
        `, [nom, description || null, couleur || '#667eea', icone || '📚', ordre || 0]);
        
        res.json({
            success: true,
            message: 'Thème créé',
            data: { id: result.insertId }
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({
                success: false,
                message: 'Ce thème existe déjà'
            });
        }
        console.error('Erreur création thème:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/catalogue/admin/themes/:id
 * Modifier un thème
 */
router.put('/admin/themes/:id', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { nom, description, couleur, icone, ordre, actif } = req.body;
        
        await query(`
            UPDATE themes 
            SET nom = ?, description = ?, couleur = ?, icone = ?, ordre = ?, actif = ?
            WHERE id = ?
        `, [nom, description, couleur, icone, ordre, actif !== false, id]);
        
        res.json({ success: true, message: 'Thème modifié' });
    } catch (error) {
        console.error('Erreur modification thème:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * DELETE /api/catalogue/admin/themes/:id
 * Supprimer un thème (met les ateliers à theme_id = NULL)
 */
router.delete('/admin/themes/:id', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Mettre à NULL les ateliers de ce thème
        await query('UPDATE ateliers SET theme_id = NULL WHERE theme_id = ?', [id]);
        
        // Supprimer le thème
        await query('DELETE FROM themes WHERE id = ?', [id]);
        
        res.json({ success: true, message: 'Thème supprimé' });
    } catch (error) {
        console.error('Erreur suppression thème:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/catalogue/admin/ateliers/:id/theme
 * Assigner un thème à un atelier
 */
router.put('/admin/ateliers/:id/theme', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { theme_id } = req.body;
        
        await query('UPDATE ateliers SET theme_id = ? WHERE id = ?', [theme_id || null, id]);
        
        res.json({ success: true, message: 'Thème assigné' });
    } catch (error) {
        console.error('Erreur assignation thème:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

module.exports = router;
