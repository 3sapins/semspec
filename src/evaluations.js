/**
 * Routes Évaluations - Commentaires et notes des élèves
 */
const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authMiddleware, adminMiddleware, enseignantMiddleware, eleveMiddleware } = require('../middleware/auth');

// ===================== ROUTES ADMIN =====================

/**
 * GET /api/evaluations/admin/config
 * Configuration des évaluations (admin)
 */
router.get('/admin/config', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const config = await query("SELECT valeur FROM configuration WHERE cle = 'evaluations_ouvertes'");
        const ouvertes = config.length > 0 ? config[0].valeur === 'true' : false;
        res.json({ success: true, data: { evaluations_ouvertes: ouvertes } });
    } catch (error) {
        console.error('Erreur config evaluations:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/evaluations/admin/config
 * Modifier configuration des évaluations (admin)
 */
router.put('/admin/config', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { evaluations_ouvertes } = req.body;
        await query(
            "INSERT INTO configuration (cle, valeur) VALUES ('evaluations_ouvertes', ?) ON DUPLICATE KEY UPDATE valeur = ?",
            [evaluations_ouvertes ? 'true' : 'false', evaluations_ouvertes ? 'true' : 'false']
        );
        res.json({ success: true, message: `Évaluations ${evaluations_ouvertes ? 'ouvertes' : 'fermées'}` });
    } catch (error) {
        console.error('Erreur config evaluations:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/evaluations/admin/parametres
 * Alias pour modifier configuration (compatibilité frontend)
 */
router.put('/admin/parametres', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { evaluations_ouvertes } = req.body;
        await query(
            "INSERT INTO configuration (cle, valeur) VALUES ('evaluations_ouvertes', ?) ON DUPLICATE KEY UPDATE valeur = ?",
            [evaluations_ouvertes ? 'true' : 'false', evaluations_ouvertes ? 'true' : 'false']
        );
        res.json({ success: true, message: `Évaluations ${evaluations_ouvertes ? 'ouvertes' : 'fermées'}` });
    } catch (error) {
        console.error('Erreur config evaluations:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/evaluations/admin/toutes
 * Liste de toutes les évaluations (admin)
 */
router.get('/admin/toutes', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const evaluations = await query(`
            SELECT ev.*, 
                u.nom as eleve_nom, u.prenom as eleve_prenom,
                a.nom as atelier_nom, a.enseignant_acronyme,
                t.nom as theme_nom, t.couleur as theme_couleur,
                DATE_FORMAT(ev.date_evaluation, '%d/%m/%Y %H:%i') as date_formatee
            FROM evaluations ev
            JOIN eleves e ON ev.eleve_id = e.id
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            LEFT JOIN ateliers a ON ev.atelier_id = a.id
            LEFT JOIN themes t ON a.theme_id = t.id
            ORDER BY ev.date_evaluation DESC
        `);
        res.json({ success: true, data: evaluations });
    } catch (error) {
        console.error('Erreur liste evaluations:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/evaluations/admin/stats
 * Statistiques des évaluations (admin)
 */
router.get('/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const stats = await query(`
            SELECT 
                COUNT(*) as total_evaluations,
                AVG(note) as moyenne_generale,
                COUNT(DISTINCT eleve_id) as nb_eleves_evaluateurs,
                COUNT(DISTINCT atelier_id) as nb_ateliers_evalues,
                COUNT(CASE WHEN note >= 5 THEN 1 END) as nb_positifs,
                COUNT(CASE WHEN note <= 2 THEN 1 END) as nb_negatifs
            FROM evaluations
        `);
        
        const topAteliers = await query(`
            SELECT a.id, a.nom, 
                COUNT(ev.id) as nb,
                AVG(ev.note) as moyenne
            FROM ateliers a
            JOIN evaluations ev ON ev.atelier_id = a.id
            WHERE a.statut = 'valide'
            GROUP BY a.id
            HAVING COUNT(ev.id) > 0
            ORDER BY moyenne DESC
            LIMIT 10
        `);
        
        res.json({ success: true, data: { stats: stats[0], topAteliers } });
    } catch (error) {
        console.error('Erreur stats evaluations:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/evaluations/admin/atelier/:id/bloquer
 * Bloquer/débloquer les évaluations pour un atelier (admin)
 */
router.put('/admin/atelier/:id/bloquer', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { bloquer } = req.body;
        
        await query('UPDATE ateliers SET evaluations_bloquees = ? WHERE id = ?', [bloquer, id]);
        res.json({ success: true, message: `Évaluations ${bloquer ? 'bloquées' : 'débloquées'} pour cet atelier` });
    } catch (error) {
        console.error('Erreur blocage:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/evaluations/admin/:id/moderer
 * Modérer une évaluation (masquer/afficher)
 */
router.put('/admin/:id/moderer', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { visible } = req.body;
        await query('UPDATE evaluations SET visible = ? WHERE id = ?', [visible ? 1 : 0, id]);
        res.json({ success: true, message: `Évaluation ${visible ? 'visible' : 'masquée'}` });
    } catch (error) {
        console.error('Erreur modération:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * DELETE /api/evaluations/admin/:id
 * Supprimer une évaluation (admin)
 */
router.delete('/admin/:id', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        await query('DELETE FROM evaluations WHERE id = ?', [id]);
        res.json({ success: true, message: 'Évaluation supprimée' });
    } catch (error) {
        console.error('Erreur suppression:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ===================== ROUTES ENSEIGNANT =====================

/**
 * GET /api/evaluations/enseignant/mes-ateliers
 * Évaluations des ateliers de l'enseignant connecté
 */
router.get('/enseignant/mes-ateliers', authMiddleware, enseignantMiddleware, async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        
        const evaluations = await query(`
            SELECT ev.*, 
                u.nom as eleve_nom, u.prenom as eleve_prenom,
                cl.nom as classe_nom,
                a.nom as atelier_nom, a.id as atelier_id
            FROM evaluations ev
            JOIN eleves e ON ev.eleve_id = e.id
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes cl ON e.classe_id = cl.id
            JOIN ateliers a ON ev.atelier_id = a.id
            WHERE a.enseignant_acronyme = ? 
               OR a.enseignant2_acronyme = ? 
               OR a.enseignant3_acronyme = ?
            ORDER BY a.nom, ev.date_evaluation DESC
        `, [acronyme, acronyme, acronyme]);
        
        // Stats par atelier
        const stats = await query(`
            SELECT a.id, a.nom, 
                COUNT(ev.id) as nb_evaluations,
                AVG(ev.note) as note_moyenne
            FROM ateliers a
            LEFT JOIN evaluations ev ON ev.atelier_id = a.id
            WHERE (a.enseignant_acronyme = ? OR a.enseignant2_acronyme = ? OR a.enseignant3_acronyme = ?)
              AND a.statut = 'valide'
            GROUP BY a.id
        `, [acronyme, acronyme, acronyme]);
        
        res.json({ success: true, data: { evaluations, stats } });
    } catch (error) {
        console.error('Erreur evaluations enseignant:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ===================== ROUTES ÉLÈVE =====================

/**
 * GET /api/evaluations/eleve/mes-evaluations
 * Évaluations de l'élève connecté
 */
router.get('/eleve/mes-evaluations', authMiddleware, eleveMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Récupérer l'élève
        const eleves = await query('SELECT id FROM eleves WHERE utilisateur_id = ?', [userId]);
        if (eleves.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        const eleveId = eleves[0].id;
        
        // Vérifier si évaluations ouvertes
        const config = await query("SELECT valeur FROM configuration WHERE cle = 'evaluations_ouvertes'");
        const evaluationsOuvertes = config.length > 0 ? config[0].valeur === 'true' : false;
        
        // Mes évaluations déjà faites
        const mesEvaluations = await query(`
            SELECT ev.*, a.nom as atelier_nom
            FROM evaluations ev
            JOIN ateliers a ON ev.atelier_id = a.id
            WHERE ev.eleve_id = ?
        `, [eleveId]);
        
        // Ateliers où je suis inscrit (pour pouvoir évaluer)
        const ateliersInscrits = await query(`
            SELECT DISTINCT a.id, a.nom, a.evaluations_bloquees,
                (SELECT ev.id FROM evaluations ev WHERE ev.eleve_id = ? AND ev.atelier_id = a.id) as evaluation_id
            FROM inscriptions i
            JOIN ateliers a ON i.atelier_id = a.id
            WHERE i.eleve_id = ? AND i.statut = 'confirmee' AND a.statut = 'valide'
        `, [eleveId, eleveId]);
        
        res.json({ 
            success: true, 
            data: { 
                evaluations_ouvertes: evaluationsOuvertes,
                mes_evaluations: mesEvaluations,
                ateliers_a_evaluer: ateliersInscrits.filter(a => !a.evaluation_id && !a.evaluations_bloquees)
            }
        });
    } catch (error) {
        console.error('Erreur mes evaluations:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/evaluations/eleve/evaluer
 * Soumettre une évaluation
 */
router.post('/eleve/evaluer', authMiddleware, eleveMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { atelier_id, note, commentaire } = req.body;
        
        if (!atelier_id || !note || note < 1 || note > 6) {
            return res.status(400).json({ success: false, message: 'Atelier et note (1-6) requis' });
        }
        
        // Vérifier si évaluations ouvertes
        const config = await query("SELECT valeur FROM configuration WHERE cle = 'evaluations_ouvertes'");
        const evaluationsOuvertes = config.length > 0 ? config[0].valeur === 'true' : false;
        if (!evaluationsOuvertes) {
            return res.status(403).json({ success: false, message: 'Les évaluations sont fermées' });
        }
        
        // Récupérer l'élève
        const eleves = await query('SELECT id FROM eleves WHERE utilisateur_id = ?', [userId]);
        if (eleves.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        const eleveId = eleves[0].id;
        
        // Vérifier que l'atelier n'a pas bloqué les évaluations
        const ateliers = await query('SELECT evaluations_bloquees FROM ateliers WHERE id = ?', [atelier_id]);
        if (ateliers.length > 0 && ateliers[0].evaluations_bloquees) {
            return res.status(403).json({ success: false, message: 'Les évaluations sont bloquées pour cet atelier' });
        }
        
        // Vérifier que l'élève est inscrit à cet atelier
        const inscriptions = await query(`
            SELECT id FROM inscriptions 
            WHERE eleve_id = ? AND atelier_id = ? AND statut = 'confirmee'
        `, [eleveId, atelier_id]);
        
        if (inscriptions.length === 0) {
            return res.status(403).json({ success: false, message: 'Vous n\'êtes pas inscrit à cet atelier' });
        }
        
        // Vérifier si déjà évalué
        const existing = await query('SELECT id FROM evaluations WHERE eleve_id = ? AND atelier_id = ?', [eleveId, atelier_id]);
        if (existing.length > 0) {
            // Mettre à jour
            await query(`
                UPDATE evaluations SET note = ?, commentaire = ?, date_evaluation = NOW()
                WHERE eleve_id = ? AND atelier_id = ?
            `, [note, commentaire || null, eleveId, atelier_id]);
            res.json({ success: true, message: 'Évaluation mise à jour' });
        } else {
            // Créer
            await query(`
                INSERT INTO evaluations (eleve_id, atelier_id, note, commentaire)
                VALUES (?, ?, ?, ?)
            `, [eleveId, atelier_id, note, commentaire || null]);
            res.json({ success: true, message: 'Évaluation enregistrée' });
        }
    } catch (error) {
        console.error('Erreur evaluation:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/evaluations/eleve/historique
 * Historique des années précédentes pour l'élève
 */
router.get('/eleve/historique', authMiddleware, eleveMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const historique = await query(`
            SELECT ai.*, ar.annee, ar.nom as archive_nom
            FROM archives_inscriptions ai
            JOIN archives ar ON ai.archive_id = ar.id
            WHERE ai.eleve_utilisateur_id = ?
            ORDER BY ar.annee DESC, ai.atelier_nom
        `, [userId]);
        
        res.json({ success: true, data: historique });
    } catch (error) {
        console.error('Erreur historique:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

module.exports = router;
