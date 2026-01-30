const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authMiddleware, enseignantMiddleware } = require('../middleware/auth');

router.use(authMiddleware, enseignantMiddleware);

/**
 * GET /api/enseignants/dashboard
 */
router.get('/dashboard', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        
        const ateliers = await query(`
            SELECT statut, COUNT(*) as count, COALESCE(SUM(budget_max), 0) as budget_total
            FROM ateliers 
            WHERE enseignant_acronyme = ? OR enseignant2_acronyme = ? OR enseignant3_acronyme = ?
            GROUP BY statut
        `, [acronyme, acronyme, acronyme]);
        
        const inscriptions = await query(`
            SELECT COUNT(DISTINCT i.id) as total
            FROM inscriptions i
            JOIN planning p ON i.planning_id = p.id
            JOIN ateliers a ON p.atelier_id = a.id
            WHERE (a.enseignant_acronyme = ? OR a.enseignant2_acronyme = ? OR a.enseignant3_acronyme = ?)
            AND i.statut = 'confirmee'
        `, [acronyme, acronyme, acronyme]);
        
        const disponibilites = await query(`
            SELECT COUNT(*) as count FROM disponibilites_enseignants
            WHERE enseignant_acronyme = ? AND disponible = TRUE
        `, [acronyme]);
        
        const validation = await query(`
            SELECT valide FROM disponibilites_enseignants WHERE enseignant_acronyme = ? LIMIT 1
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
        console.error('Erreur dashboard:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/enseignants/mon-horaire
 */
router.get('/mon-horaire', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        
        const horaire = await query(`
            SELECT p.id as planning_id, p.creneau_id, p.nombre_creneaux,
                a.id as atelier_id, a.nom as atelier_nom, a.duree, a.nombre_places_max,
                c.jour, c.periode, c.ordre, s.nom as salle_nom,
                (SELECT COUNT(*) FROM inscriptions WHERE planning_id = p.id AND statut = 'confirmee') as nb_inscrits
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            WHERE a.enseignant_acronyme = ? OR a.enseignant2_acronyme = ? OR a.enseignant3_acronyme = ?
            ORDER BY c.ordre
        `, [acronyme, acronyme, acronyme]);
        
        const creneaux = await query('SELECT * FROM creneaux ORDER BY ordre');
        
        res.json({ success: true, data: { ateliers: horaire, creneaux: creneaux } });
    } catch (error) {
        console.error('Erreur horaire:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/enseignants/listes/:planningId
 */
router.get('/listes/:planningId', async (req, res) => {
    try {
        const { planningId } = req.params;
        const acronyme = req.user.acronyme;
        
        const planning = await query(`
            SELECT p.id, a.nom, a.nombre_places_max, c.jour, c.periode, s.nom as salle_nom
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            WHERE p.id = ? AND (a.enseignant_acronyme = ? OR a.enseignant2_acronyme = ? OR a.enseignant3_acronyme = ?)
        `, [planningId, acronyme, acronyme, acronyme]);
        
        if (planning.length === 0) {
            return res.status(404).json({ success: false, message: 'Planning non trouvé' });
        }
        
        const eleves = await query(`
            SELECT e.id, u.nom, u.prenom, cl.nom as classe_nom
            FROM inscriptions i
            JOIN eleves e ON i.eleve_id = e.id
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes cl ON e.classe_id = cl.id
            WHERE i.planning_id = ? AND i.statut = 'confirmee'
            ORDER BY cl.nom, u.nom, u.prenom
        `, [planningId]);
        
        res.json({ success: true, data: { planning: planning[0], eleves: eleves } });
    } catch (error) {
        console.error('Erreur liste:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/enseignants/mes-ateliers
 */
router.get('/mes-ateliers', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        
        const ateliers = await query(`
            SELECT a.*, t.nom as theme_nom, t.couleur as theme_couleur,
                (SELECT COUNT(*) FROM inscriptions i JOIN planning p ON i.planning_id = p.id 
                 WHERE p.atelier_id = a.id AND i.statut = 'confirmee') as nb_inscrits
            FROM ateliers a
            LEFT JOIN themes t ON a.theme_id = t.id
            WHERE a.enseignant_acronyme = ? OR a.enseignant2_acronyme = ? OR a.enseignant3_acronyme = ?
            ORDER BY a.id DESC
        `, [acronyme, acronyme, acronyme]);
        
        res.json({ success: true, data: ateliers });
    } catch (error) {
        console.error('Erreur ateliers:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/enseignants/catalogue
 */
router.get('/catalogue', async (req, res) => {
    try {
        const ateliers = await query(`
            SELECT a.id, a.nom, a.description, a.duree, a.nombre_places_max, a.informations_eleves,
                a.enseignant_acronyme, a.enseignant2_acronyme, a.enseignant3_acronyme,
                t.id as theme_id, t.nom as theme_nom, t.couleur as theme_couleur, t.icone as theme_icone,
                u.nom as enseignant_nom, u.prenom as enseignant_prenom
            FROM ateliers a
            LEFT JOIN themes t ON a.theme_id = t.id
            LEFT JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            WHERE a.statut = 'valide'
            ORDER BY t.nom, a.nom
        `);
        
        const themes = await query('SELECT * FROM themes ORDER BY nom');
        
        for (const atelier of ateliers) {
            const creneaux = await query(`
                SELECT c.jour, c.periode, s.nom as salle,
                    (SELECT COUNT(*) FROM inscriptions WHERE planning_id = p.id AND statut = 'confirmee') as nb_inscrits
                FROM planning p
                JOIN creneaux c ON p.creneau_id = c.id
                LEFT JOIN salles s ON p.salle_id = s.id
                WHERE p.atelier_id = ?
            `, [atelier.id]);
            atelier.creneaux = creneaux;
        }
        
        res.json({ success: true, data: { ateliers, themes } });
    } catch (error) {
        console.error('Erreur catalogue:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/enseignants/disponibilites
 */
router.get('/disponibilites', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        const creneaux = await query('SELECT * FROM creneaux ORDER BY ordre');
        
        const disponibilites = await query(
            'SELECT * FROM disponibilites_enseignants WHERE enseignant_acronyme = ?',
            [acronyme]
        );
        
        const validation = disponibilites.length > 0 ? disponibilites[0].valide : false;
        
        const dispoMap = {};
        disponibilites.forEach(d => {
            dispoMap[d.creneau_id] = {
                disponible: d.disponible,
                periodes_enseignees_normalement: d.periodes_enseignees_normalement
            };
        });
        
        const result = creneaux.map(c => ({
            ...c,
            disponible: dispoMap[c.id]?.disponible || false,
            periodes_enseignees_normalement: dispoMap[c.id]?.periodes_enseignees_normalement || 0
        }));
        
        res.json({ success: true, data: { creneaux: result, valide: validation } });
    } catch (error) {
        console.error('Erreur disponibilités:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/enseignants/disponibilites
 * CORRIGÉ - Sans transaction
 */
router.put('/disponibilites', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        const { disponibilites } = req.body;
        
        console.log('PUT disponibilites reçu:', { acronyme, nb: disponibilites?.length });
        
        if (!Array.isArray(disponibilites)) {
            return res.status(400).json({ success: false, message: 'Format invalide' });
        }
        
        // Vérifier si déjà validées
        const existantes = await query(
            'SELECT valide FROM disponibilites_enseignants WHERE enseignant_acronyme = ? LIMIT 1',
            [acronyme]
        );
        
        if (existantes.length > 0 && existantes[0].valide) {
            return res.status(403).json({ success: false, message: 'Disponibilités validées, non modifiables' });
        }
        
        // Supprimer les anciennes
        await query('DELETE FROM disponibilites_enseignants WHERE enseignant_acronyme = ?', [acronyme]);
        
        // Insérer les nouvelles
        for (const dispo of disponibilites) {
            await query(`
                INSERT INTO disponibilites_enseignants 
                (enseignant_acronyme, creneau_id, disponible, periodes_enseignees_normalement, valide)
                VALUES (?, ?, ?, ?, FALSE)
            `, [acronyme, dispo.creneau_id, dispo.disponible ? 1 : 0, dispo.periodes_enseignees_normalement || 0]);
        }
        
        res.json({ success: true, message: 'Disponibilités enregistrées' });
    } catch (error) {
        console.error('Erreur mise à jour disponibilités:', error);
        res.status(500).json({ success: false, message: 'Erreur: ' + error.message });
    }
});

/**
 * GET /api/enseignants/types-salles
 */
router.get('/types-salles', async (req, res) => {
    try {
        const types = await query(`
            SELECT DISTINCT type_salle FROM salles 
            WHERE type_salle IS NOT NULL AND disponible = TRUE
            ORDER BY type_salle
        `);
        res.json({ success: true, data: types.map(t => t.type_salle) });
    } catch (error) {
        console.error('Erreur types salles:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/enseignants/themes
 */
router.get('/themes', async (req, res) => {
    try {
        const themes = await query('SELECT * FROM themes ORDER BY nom');
        res.json({ success: true, data: themes });
    } catch (error) {
        console.error('Erreur thèmes:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/enseignants/ateliers
 */
router.post('/ateliers', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        const { nom, description, informations_eleves, duree, nombre_places_max, theme_id,
            besoin_salle_specifique, type_salle_demande, materiel_necessaire, budget_max,
            lieu_externe, deplacement_prevu, enseignant2_acronyme, enseignant3_acronyme } = req.body;
        
        if (!nom || !duree || !nombre_places_max) {
            return res.status(400).json({ success: false, message: 'Nom, durée et places requis' });
        }
        
        const result = await query(`
            INSERT INTO ateliers (nom, description, informations_eleves, duree, nombre_places_max,
                theme_id, besoin_salle_specifique, type_salle_demande, materiel_necessaire,
                budget_max, lieu_externe, deplacement_prevu, enseignant_acronyme,
                enseignant2_acronyme, enseignant3_acronyme, statut)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'brouillon')
        `, [nom, description, informations_eleves, duree, nombre_places_max, theme_id || null,
            besoin_salle_specifique || false, type_salle_demande, materiel_necessaire,
            budget_max || 0, lieu_externe, deplacement_prevu || false, acronyme,
            enseignant2_acronyme || null, enseignant3_acronyme || null]);
        
        res.json({ success: true, message: 'Atelier créé', data: { id: result.insertId } });
    } catch (error) {
        console.error('Erreur création atelier:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/enseignants/ateliers/:id
 */
router.put('/ateliers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const acronyme = req.user.acronyme;
        
        const ateliers = await query('SELECT * FROM ateliers WHERE id = ?', [id]);
        if (ateliers.length === 0) {
            return res.status(404).json({ success: false, message: 'Atelier non trouvé' });
        }
        
        const atelier = ateliers[0];
        if (atelier.enseignant_acronyme !== acronyme && atelier.enseignant2_acronyme !== acronyme && atelier.enseignant3_acronyme !== acronyme) {
            return res.status(403).json({ success: false, message: 'Non autorisé' });
        }
        
        const { nom, description, informations_eleves, duree, nombre_places_max, theme_id,
            besoin_salle_specifique, type_salle_demande, materiel_necessaire, budget_max,
            lieu_externe, deplacement_prevu, enseignant2_acronyme, enseignant3_acronyme } = req.body;
        
        await query(`
            UPDATE ateliers SET nom = ?, description = ?, informations_eleves = ?, duree = ?,
                nombre_places_max = ?, theme_id = ?, besoin_salle_specifique = ?,
                type_salle_demande = ?, materiel_necessaire = ?, budget_max = ?,
                lieu_externe = ?, deplacement_prevu = ?, enseignant2_acronyme = ?,
                enseignant3_acronyme = ?, statut = 'brouillon'
            WHERE id = ?
        `, [nom, description, informations_eleves, duree, nombre_places_max, theme_id || null,
            besoin_salle_specifique || false, type_salle_demande, materiel_necessaire,
            budget_max || 0, lieu_externe, deplacement_prevu || false,
            enseignant2_acronyme || null, enseignant3_acronyme || null, id]);
        
        res.json({ success: true, message: 'Atelier modifié (retour en brouillon)' });
    } catch (error) {
        console.error('Erreur modification atelier:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/enseignants/ateliers/:id/soumettre
 */
router.put('/ateliers/:id/soumettre', async (req, res) => {
    try {
        const { id } = req.params;
        const acronyme = req.user.acronyme;
        
        const ateliers = await query('SELECT * FROM ateliers WHERE id = ?', [id]);
        if (ateliers.length === 0) {
            return res.status(404).json({ success: false, message: 'Atelier non trouvé' });
        }
        
        const atelier = ateliers[0];
        if (atelier.enseignant_acronyme !== acronyme) {
            return res.status(403).json({ success: false, message: 'Non autorisé' });
        }
        
        if (atelier.statut !== 'brouillon') {
            return res.status(400).json({ success: false, message: 'Seul un brouillon peut être soumis' });
        }
        
        await query('UPDATE ateliers SET statut = "en_attente" WHERE id = ?', [id]);
        res.json({ success: true, message: 'Atelier soumis pour validation' });
    } catch (error) {
        console.error('Erreur soumission:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * DELETE /api/enseignants/ateliers/:id
 */
router.delete('/ateliers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const acronyme = req.user.acronyme;
        
        const ateliers = await query('SELECT * FROM ateliers WHERE id = ?', [id]);
        if (ateliers.length === 0) {
            return res.status(404).json({ success: false, message: 'Atelier non trouvé' });
        }
        
        if (ateliers[0].enseignant_acronyme !== acronyme) {
            return res.status(403).json({ success: false, message: 'Non autorisé' });
        }
        
        if (ateliers[0].statut !== 'brouillon') {
            return res.status(400).json({ success: false, message: 'Seul un brouillon peut être supprimé' });
        }
        
        await query('DELETE FROM ateliers WHERE id = ?', [id]);
        res.json({ success: true, message: 'Atelier supprimé' });
    } catch (error) {
        console.error('Erreur suppression:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

module.exports = router;
