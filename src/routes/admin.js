const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authMiddleware, adminMiddleware, enseignantMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// ========== THEMES (public) ==========
router.get('/themes', async (req, res) => {
    try {
        const themes = await query('SELECT * FROM themes ORDER BY nom');
        res.json({ success: true, data: themes });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ========== ATELIERS ==========
router.get('/ateliers', adminMiddleware, async (req, res) => {
    try {
        const { statut } = req.query;
        let whereClause = '';
        let params = [];
        
        if (statut) {
            whereClause = 'WHERE a.statut = ?';
            params.push(statut);
        }
        
        const ateliers = await query(`
            SELECT a.*, t.nom as theme_nom, t.couleur as theme_couleur,
                u.nom as enseignant_nom, u.prenom as enseignant_prenom,
                (SELECT COUNT(*) FROM inscriptions WHERE atelier_id = a.id AND statut = 'confirmee') as nb_inscrits
            FROM ateliers a
            LEFT JOIN themes t ON a.theme_id = t.id
            LEFT JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            ${whereClause}
            ORDER BY a.id DESC
        `, params);
        
        res.json({ success: true, data: ateliers });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// Récupérer un atelier pour édition
router.get('/ateliers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const ateliers = await query(`
            SELECT a.*, t.nom as theme_nom
            FROM ateliers a
            LEFT JOIN themes t ON a.theme_id = t.id
            WHERE a.id = ?
        `, [id]);
        
        if (ateliers.length === 0) {
            return res.status(404).json({ success: false, message: 'Atelier non trouvé' });
        }
        
        res.json({ success: true, data: ateliers[0] });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// Créer un atelier
router.post('/ateliers', enseignantMiddleware, async (req, res) => {
    try {
        const {
            nom, description, informations_eleves, duree, nombre_places_max,
            theme_id, besoin_salle_specifique, type_salle_demande, materiel_necessaire,
            budget_max, lieu_externe, deplacement_prevu
        } = req.body;
        
        if (!nom || !duree || !nombre_places_max) {
            return res.status(400).json({ success: false, message: 'Nom, durée et places requis' });
        }
        
        const result = await query(`
            INSERT INTO ateliers (
                nom, description, informations_eleves, duree, nombre_places_max,
                theme_id, besoin_salle_specifique, type_salle_demande, materiel_necessaire,
                budget_max, lieu_externe, deplacement_prevu,
                enseignant_acronyme, statut
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'brouillon')
        `, [nom, description, informations_eleves, duree, nombre_places_max,
            theme_id, besoin_salle_specifique || false, type_salle_demande, materiel_necessaire,
            budget_max || 0, lieu_externe, deplacement_prevu || false,
            req.user.acronyme]);
        
        res.json({ success: true, message: 'Atelier créé en brouillon', data: { id: result.insertId } });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// Modifier un atelier (revient en brouillon si était validé/en_attente)
router.put('/ateliers/:id', enseignantMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            nom, description, informations_eleves, duree, nombre_places_max,
            theme_id, besoin_salle_specifique, type_salle_demande, materiel_necessaire,
            budget_max, lieu_externe, deplacement_prevu,
            enseignant2_acronyme, enseignant3_acronyme
        } = req.body;
        
        // Vérifier que l'atelier existe
        const ateliers = await query('SELECT * FROM ateliers WHERE id = ?', [id]);
        if (ateliers.length === 0) {
            return res.status(404).json({ success: false, message: 'Atelier non trouvé' });
        }
        
        const atelier = ateliers[0];
        
        // Vérifier les droits (propriétaire ou admin)
        if (req.user.role !== 'admin' && atelier.enseignant_acronyme !== req.user.acronyme) {
            return res.status(403).json({ success: false, message: 'Non autorisé' });
        }
        
        // Si l'atelier était validé ou en_attente, il revient en brouillon
        const ancienStatut = atelier.statut;
        let nouveauStatut = 'brouillon';
        let messageStatut = '';
        
        if (ancienStatut === 'valide') {
            messageStatut = ' (était validé, revient en brouillon pour nouvelle validation)';
            // Retirer du planning si placé
            await query('DELETE FROM planning WHERE atelier_id = ?', [id]);
        } else if (ancienStatut === 'en_attente') {
            messageStatut = ' (était en attente, revient en brouillon)';
        }
        
        await query(`
            UPDATE ateliers SET
                nom = COALESCE(?, nom),
                description = ?,
                informations_eleves = ?,
                duree = COALESCE(?, duree),
                nombre_places_max = COALESCE(?, nombre_places_max),
                theme_id = ?,
                besoin_salle_specifique = COALESCE(?, besoin_salle_specifique),
                type_salle_demande = ?,
                materiel_necessaire = ?,
                budget_max = COALESCE(?, budget_max),
                lieu_externe = ?,
                deplacement_prevu = COALESCE(?, deplacement_prevu),
                enseignant2_acronyme = ?,
                enseignant3_acronyme = ?,
                statut = ?
            WHERE id = ?
        `, [nom, description, informations_eleves, duree, nombre_places_max,
            theme_id, besoin_salle_specifique, type_salle_demande, materiel_necessaire,
            budget_max, lieu_externe, deplacement_prevu,
            enseignant2_acronyme || null, enseignant3_acronyme || null,
            nouveauStatut, id]);
        
        // Log
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'UPDATE', 'ateliers', id, `Modification atelier, ancien statut: ${ancienStatut}`]
        );
        
        res.json({ 
            success: true, 
            message: `Atelier modifié${messageStatut}`,
            data: { ancien_statut: ancienStatut, nouveau_statut: nouveauStatut }
        });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// Soumettre un atelier (brouillon -> en_attente)
router.put('/ateliers/:id/soumettre', enseignantMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        
        const ateliers = await query('SELECT * FROM ateliers WHERE id = ?', [id]);
        if (ateliers.length === 0) {
            return res.status(404).json({ success: false, message: 'Atelier non trouvé' });
        }
        
        const atelier = ateliers[0];
        
        if (req.user.role !== 'admin' && atelier.enseignant_acronyme !== req.user.acronyme) {
            return res.status(403).json({ success: false, message: 'Non autorisé' });
        }
        
        if (atelier.statut !== 'brouillon') {
            return res.status(400).json({ success: false, message: 'Seul un brouillon peut être soumis' });
        }
        
        await query('UPDATE ateliers SET statut = "en_attente" WHERE id = ?', [id]);
        
        res.json({ success: true, message: 'Atelier soumis pour validation' });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// Valider un atelier (admin)
router.put('/ateliers/:id/valider', adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        
        const ateliers = await query('SELECT * FROM ateliers WHERE id = ?', [id]);
        if (ateliers.length === 0) {
            return res.status(404).json({ success: false, message: 'Atelier non trouvé' });
        }
        
        await query('UPDATE ateliers SET statut = "valide" WHERE id = ?', [id]);
        
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'VALIDATE', 'ateliers', id, 'Validation atelier']
        );
        
        res.json({ success: true, message: 'Atelier validé' });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// Refuser un atelier (admin)
router.put('/ateliers/:id/refuser', adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { motif } = req.body;
        
        await query('UPDATE ateliers SET statut = "refuse", motif_refus = ? WHERE id = ?', [motif || 'Non spécifié', id]);
        
        res.json({ success: true, message: 'Atelier refusé' });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// Supprimer un atelier
router.delete('/ateliers/:id', enseignantMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        
        const ateliers = await query('SELECT * FROM ateliers WHERE id = ?', [id]);
        if (ateliers.length === 0) {
            return res.status(404).json({ success: false, message: 'Atelier non trouvé' });
        }
        
        const atelier = ateliers[0];
        
        if (req.user.role !== 'admin' && atelier.enseignant_acronyme !== req.user.acronyme) {
            return res.status(403).json({ success: false, message: 'Non autorisé' });
        }
        
        // Supprimer les inscriptions et le planning
        await query('DELETE FROM inscriptions WHERE atelier_id = ?', [id]);
        await query('DELETE FROM planning WHERE atelier_id = ?', [id]);
        await query('DELETE FROM ateliers WHERE id = ?', [id]);
        
        res.json({ success: true, message: 'Atelier supprimé' });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

module.exports = router;
