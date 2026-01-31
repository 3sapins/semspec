const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');

// Middleware pour vérifier que c'est un élève
const eleveMiddleware = (req, res, next) => {
    if (req.user.role !== 'eleve' && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Accès réservé aux élèves' });
    }
    next();
};

router.use(authMiddleware, eleveMiddleware);

/**
 * GET /api/eleves/profil
 * Profil de l'élève avec statut de validation
 */
router.get('/profil', async (req, res) => {
    try {
        const userId = req.user.id;
        
        const eleve = await query(`
            SELECT e.id as eleve_id, e.numero_eleve, e.inscriptions_validees, e.date_validation,
                u.nom, u.prenom, u.email, c.nom as classe_nom, c.niveau
            FROM eleves e
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes c ON e.classe_id = c.id
            WHERE e.utilisateur_id = ?
        `, [userId]);
        
        if (eleve.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        
        // Compter les inscriptions
        const inscriptions = await query(`
            SELECT COUNT(*) as total FROM inscriptions 
            WHERE eleve_id = ? AND statut = 'confirmee'
        `, [eleve[0].eleve_id]);
        
        // Vérifier s'il y a des notifications
        const notifications = await query(`
            SELECT COUNT(*) as total FROM notifications_eleves
            WHERE eleve_id = ? AND lue = FALSE
        `, [eleve[0].eleve_id]);
        
        res.json({
            success: true,
            data: {
                ...eleve[0],
                nb_inscriptions: inscriptions[0].total,
                nb_notifications: notifications[0].total
            }
        });
    } catch (error) {
        console.error('Erreur profil:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/eleves/notifications
 * Notifications de l'élève
 */
router.get('/notifications', async (req, res) => {
    try {
        const userId = req.user.id;
        
        const eleve = await query('SELECT id FROM eleves WHERE utilisateur_id = ?', [userId]);
        if (eleve.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        
        const notifications = await query(`
            SELECT * FROM notifications_eleves
            WHERE eleve_id = ?
            ORDER BY created_at DESC
            LIMIT 20
        `, [eleve[0].id]);
        
        res.json({ success: true, data: notifications });
    } catch (error) {
        console.error('Erreur notifications:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/eleves/notifications/:id/lue
 * Marquer notification comme lue
 */
router.put('/notifications/:id/lue', async (req, res) => {
    try {
        const { id } = req.params;
        await query('UPDATE notifications_eleves SET lue = TRUE WHERE id = ?', [id]);
        res.json({ success: true, message: 'Notification marquée comme lue' });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/eleves/mon-horaire
 * Horaire de l'élève
 */
router.get('/mon-horaire', async (req, res) => {
    try {
        const userId = req.user.id;
        
        const eleve = await query('SELECT id, inscriptions_validees FROM eleves WHERE utilisateur_id = ?', [userId]);
        if (eleve.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        
        const inscriptions = await query(`
            SELECT i.id as inscription_id, i.planning_id, i.statut,
                a.id as atelier_id, a.nom as atelier_nom, a.duree,
                c.id as creneau_id, c.jour, c.periode, c.ordre,
                s.nom as salle_nom,
                p.nombre_creneaux
            FROM inscriptions i
            JOIN planning p ON i.planning_id = p.id
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            WHERE i.eleve_id = ? AND i.statut = 'confirmee'
            ORDER BY c.ordre
        `, [eleve[0].id]);
        
        const creneaux = await query('SELECT * FROM creneaux ORDER BY ordre');
        
        res.json({
            success: true,
            data: {
                inscriptions: inscriptions,
                creneaux: creneaux,
                inscriptions_validees: eleve[0].inscriptions_validees || false
            }
        });
    } catch (error) {
        console.error('Erreur horaire:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/eleves/mes-inscriptions
 * Liste des inscriptions de l'élève connecté
 */
router.get('/mes-inscriptions', async (req, res) => {
    try {
        const userId = req.user.id;
        
        const eleve = await query('SELECT id FROM eleves WHERE utilisateur_id = ?', [userId]);
        if (eleve.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        
        const inscriptions = await query(`
            SELECT i.id as inscription_id, i.planning_id, i.statut, i.inscription_manuelle,
                a.id as atelier_id, a.nom as atelier_nom, a.duree, a.description,
                c.id as creneau_id, c.jour, c.periode, c.ordre,
                s.nom as salle_nom,
                p.nombre_creneaux,
                t.nom as theme_nom, t.couleur as theme_couleur, t.icone as theme_icone
            FROM inscriptions i
            JOIN planning p ON i.planning_id = p.id
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            LEFT JOIN themes t ON a.theme_id = t.id
            WHERE i.eleve_id = ? AND i.statut = 'confirmee'
            ORDER BY c.ordre
        `, [eleve[0].id]);
        
        res.json({ success: true, data: inscriptions });
    } catch (error) {
        console.error('Erreur mes-inscriptions:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/eleves/catalogue
 * Catalogue des ateliers disponibles
 */
router.get('/catalogue', async (req, res) => {
    try {
        const userId = req.user.id;
        const eleve = await query('SELECT id FROM eleves WHERE utilisateur_id = ?', [userId]);
        
        if (eleve.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        
        const ateliers = await query(`
            SELECT a.id, a.nom, a.description, a.informations_eleves, a.duree, a.nombre_places_max,
                t.id as theme_id, t.nom as theme_nom, t.couleur as theme_couleur, t.icone as theme_icone
            FROM ateliers a
            LEFT JOIN themes t ON a.theme_id = t.id
            WHERE a.statut = 'valide'
            ORDER BY t.nom, a.nom
        `);
        
        // Ajouter les créneaux et places disponibles
        for (const atelier of ateliers) {
            const creneaux = await query(`
                SELECT p.id as planning_id, c.jour, c.periode, s.nom as salle,
                    a.nombre_places_max,
                    (SELECT COUNT(*) FROM inscriptions WHERE planning_id = p.id AND statut = 'confirmee') as nb_inscrits
                FROM planning p
                JOIN ateliers a ON p.atelier_id = a.id
                JOIN creneaux c ON p.creneau_id = c.id
                LEFT JOIN salles s ON p.salle_id = s.id
                WHERE p.atelier_id = ?
            `, [atelier.id]);
            atelier.creneaux = creneaux;
        }
        
        const themes = await query('SELECT * FROM themes ORDER BY nom');
        
        res.json({ success: true, data: { ateliers, themes } });
    } catch (error) {
        console.error('Erreur catalogue:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/eleves/inscription
 * S'inscrire à un créneau
 */
router.post('/inscription', async (req, res) => {
    try {
        const userId = req.user.id;
        const { planning_id } = req.body;
        
        const eleve = await query('SELECT id, inscriptions_validees FROM eleves WHERE utilisateur_id = ?', [userId]);
        if (eleve.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        
        // Vérifier si les inscriptions sont validées (verrouillées)
        if (eleve[0].inscriptions_validees) {
            return res.status(403).json({ success: false, message: 'Vos inscriptions sont validées et ne peuvent plus être modifiées' });
        }
        
        // Vérifier le planning
        const planning = await query(`
            SELECT p.*, a.nombre_places_max, a.nom as atelier_nom, c.jour, c.periode
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            WHERE p.id = ?
        `, [planning_id]);
        
        if (planning.length === 0) {
            return res.status(404).json({ success: false, message: 'Créneau non trouvé' });
        }
        
        // Vérifier conflit horaire
        const conflit = await query(`
            SELECT a.nom FROM inscriptions i
            JOIN planning p ON i.planning_id = p.id
            JOIN ateliers a ON p.atelier_id = a.id
            WHERE i.eleve_id = ? AND p.creneau_id = ? AND i.statut = 'confirmee'
        `, [eleve[0].id, planning[0].creneau_id]);
        
        if (conflit.length > 0) {
            return res.status(400).json({ success: false, message: `Conflit: déjà inscrit à "${conflit[0].nom}" sur ce créneau` });
        }
        
        // Vérifier places disponibles
        const inscrits = await query('SELECT COUNT(*) as nb FROM inscriptions WHERE planning_id = ? AND statut = "confirmee"', [planning_id]);
        if (inscrits[0].nb >= planning[0].nombre_places_max) {
            return res.status(400).json({ success: false, message: 'Plus de places disponibles' });
        }
        
        // Inscrire
        await query(`
            INSERT INTO inscriptions (eleve_id, atelier_id, planning_id, statut)
            VALUES (?, ?, ?, 'confirmee')
        `, [eleve[0].id, planning[0].atelier_id, planning_id]);
        
        res.json({ success: true, message: `Inscrit à "${planning[0].atelier_nom}"` });
    } catch (error) {
        console.error('Erreur inscription:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * DELETE /api/eleves/inscription/:planningId
 * Se désinscrire d'un créneau
 */
router.delete('/inscription/:planningId', async (req, res) => {
    try {
        const userId = req.user.id;
        const { planningId } = req.params;
        
        const eleve = await query('SELECT id, inscriptions_validees FROM eleves WHERE utilisateur_id = ?', [userId]);
        if (eleve.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        
        // Vérifier si les inscriptions sont validées
        if (eleve[0].inscriptions_validees) {
            return res.status(403).json({ success: false, message: 'Vos inscriptions sont validées et ne peuvent plus être modifiées' });
        }
        
        await query('DELETE FROM inscriptions WHERE eleve_id = ? AND planning_id = ?', [eleve[0].id, planningId]);
        
        res.json({ success: true, message: 'Désinscription effectuée' });
    } catch (error) {
        console.error('Erreur désinscription:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/eleves/valider-inscriptions
 * Valider ses inscriptions (verrouillage)
 */
router.put('/valider-inscriptions', async (req, res) => {
    try {
        const userId = req.user.id;
        
        const eleve = await query('SELECT id, inscriptions_validees FROM eleves WHERE utilisateur_id = ?', [userId]);
        if (eleve.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        
        if (eleve[0].inscriptions_validees) {
            return res.status(400).json({ success: false, message: 'Inscriptions déjà validées' });
        }
        
        // Vérifier qu'il y a des inscriptions
        const inscriptions = await query('SELECT COUNT(*) as nb FROM inscriptions WHERE eleve_id = ? AND statut = "confirmee"', [eleve[0].id]);
        if (inscriptions[0].nb === 0) {
            return res.status(400).json({ success: false, message: 'Aucune inscription à valider' });
        }
        
        await query('UPDATE eleves SET inscriptions_validees = TRUE, date_validation = NOW() WHERE id = ?', [eleve[0].id]);
        
        res.json({ success: true, message: 'Inscriptions validées ! Vous ne pourrez plus les modifier.' });
    } catch (error) {
        console.error('Erreur validation:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

module.exports = router;
