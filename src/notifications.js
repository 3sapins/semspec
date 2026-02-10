/**
 * Routes Notifications
 * Gestion des notifications in-app pour enseignants et élèves
 * Préparé pour conversion future en push notifications
 */
const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// ============================================================
// FONCTIONS UTILITAIRES - Création de notifications
// Ces fonctions seront appelées depuis d'autres routes
// ============================================================

/**
 * Créer une notification pour un enseignant
 */
async function notifyEnseignant(utilisateurId, type, titre, message, lien = null, data = null) {
    try {
        await query(`
            INSERT INTO notifications_enseignants (utilisateur_id, type, titre, message, lien, data)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [utilisateurId, type, titre, message, lien, data ? JSON.stringify(data) : null]);
        return true;
    } catch (error) {
        console.error('Erreur création notification enseignant:', error);
        return false;
    }
}

/**
 * Créer une notification pour un élève
 */
async function notifyEleve(eleveId, type, titre, message, lien = null, data = null) {
    try {
        await query(`
            INSERT INTO notifications_eleves (eleve_id, type, titre, message, lien, data)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [eleveId, type, titre, message, lien, data ? JSON.stringify(data) : null]);
        return true;
    } catch (error) {
        console.error('Erreur création notification élève:', error);
        return false;
    }
}

// ============================================================
// ROUTES ENSEIGNANTS
// ============================================================

/**
 * GET /api/notifications/enseignant
 * Liste des notifications de l'enseignant connecté
 */
router.get('/enseignant', async (req, res) => {
    try {
        const utilisateurId = req.user.id;
        
        const notifications = await query(`
            SELECT id, type, titre, message, lien, data, lue, created_at
            FROM notifications_enseignants
            WHERE utilisateur_id = ?
            ORDER BY created_at DESC
            LIMIT 50
        `, [utilisateurId]);
        
        const nonLues = notifications.filter(n => !n.lue).length;
        
        res.json({ 
            success: true, 
            data: notifications,
            non_lues: nonLues
        });
    } catch (error) {
        console.error('Erreur notifications enseignant:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/notifications/enseignant/:id/lue
 * Marquer une notification enseignant comme lue
 */
router.put('/enseignant/:id/lue', async (req, res) => {
    try {
        const { id } = req.params;
        const utilisateurId = req.user.id;
        
        await query(`
            UPDATE notifications_enseignants 
            SET lue = TRUE 
            WHERE id = ? AND utilisateur_id = ?
        `, [id, utilisateurId]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/notifications/enseignant/tout-lu
 * Marquer toutes les notifications enseignant comme lues
 */
router.put('/enseignant/tout-lu', async (req, res) => {
    try {
        const utilisateurId = req.user.id;
        
        await query(`
            UPDATE notifications_enseignants 
            SET lue = TRUE 
            WHERE utilisateur_id = ? AND lue = FALSE
        `, [utilisateurId]);
        
        res.json({ success: true, message: 'Toutes les notifications marquées comme lues' });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ============================================================
// ROUTES ÉLÈVES (complément à celles existantes dans eleves.js)
// ============================================================

/**
 * PUT /api/notifications/eleve/tout-lu
 * Marquer toutes les notifications élève comme lues
 */
router.put('/eleve/tout-lu', async (req, res) => {
    try {
        const userId = req.user.id;
        
        const eleve = await query('SELECT id FROM eleves WHERE utilisateur_id = ?', [userId]);
        if (eleve.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        
        await query(`
            UPDATE notifications_eleves 
            SET lue = TRUE 
            WHERE eleve_id = ? AND lue = FALSE
        `, [eleve[0].id]);
        
        res.json({ success: true, message: 'Toutes les notifications marquées comme lues' });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ============================================================
// ROUTES ADMIN - Génération des notifications
// ============================================================

/**
 * POST /api/notifications/admin/rappels-demain
 * Générer les rappels pour les ateliers du lendemain
 * À appeler via un cron à 16h chaque jour
 */
router.post('/admin/rappels-demain', adminMiddleware, async (req, res) => {
    try {
        // Déterminer le jour de demain
        const demain = new Date();
        demain.setDate(demain.getDate() + 1);
        const joursDeSemaine = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
        const jourDemain = joursDeSemaine[demain.getDay()];
        
        // Si demain est samedi ou dimanche, pas de rappels
        if (jourDemain === 'samedi' || jourDemain === 'dimanche') {
            return res.json({ success: true, message: 'Pas d\'ateliers le week-end', count: 0 });
        }
        
        // Récupérer tous les ateliers de demain avec leurs élèves
        const ateliersDemain = await query(`
            SELECT 
                p.id as planning_id,
                a.id as atelier_id,
                a.nom as atelier_nom,
                a.informations_eleves,
                c.jour,
                c.periode,
                c.heure_debut,
                s.nom as salle_nom,
                i.eleve_id
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            JOIN inscriptions i ON i.planning_id = p.id AND i.statut = 'confirmee'
            WHERE c.jour = ? AND a.statut = 'valide'
            ORDER BY c.heure_debut
        `, [jourDemain]);
        
        // Grouper par élève pour éviter les doublons
        const notifParEleve = {};
        
        for (const atelier of ateliersDemain) {
            if (!notifParEleve[atelier.eleve_id]) {
                notifParEleve[atelier.eleve_id] = [];
            }
            notifParEleve[atelier.eleve_id].push(atelier);
        }
        
        // Créer les notifications
        let count = 0;
        const jourCap = jourDemain.charAt(0).toUpperCase() + jourDemain.slice(1);
        
        for (const [eleveId, ateliers] of Object.entries(notifParEleve)) {
            for (const atelier of ateliers) {
                const heureDebut = atelier.heure_debut ? atelier.heure_debut.substring(0, 5) : '';
                let message = `📍 ${atelier.salle_nom || 'Salle à confirmer'}`;
                if (heureDebut) message += ` à ${heureDebut}`;
                if (atelier.informations_eleves) {
                    message += `\nℹ️ ${atelier.informations_eleves}`;
                }
                
                await notifyEleve(
                    eleveId,
                    'rappel_atelier',
                    `🔔 Demain ${atelier.periode} : ${atelier.atelier_nom}`,
                    message,
                    '/eleves.html',
                    { atelier_id: atelier.atelier_id, planning_id: atelier.planning_id }
                );
                count++;
            }
        }
        
        res.json({ 
            success: true, 
            message: `${count} rappels envoyés pour ${jourCap}`,
            count: count,
            jour: jourDemain
        });
        
    } catch (error) {
        console.error('Erreur génération rappels:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur: ' + error.message });
    }
});

/**
 * POST /api/notifications/admin/rappel-semaine-speciale
 * Notifier tous les enseignants qu'on est à une semaine de la semaine spéciale
 */
router.post('/admin/rappel-semaine-speciale', adminMiddleware, async (req, res) => {
    try {
        const { message_custom } = req.body;
        
        // Récupérer tous les enseignants actifs
        const enseignants = await query(`
            SELECT id FROM utilisateurs 
            WHERE role = 'enseignant' AND actif = TRUE
        `);
        
        const titre = '📅 Semaine Spéciale dans 1 semaine !';
        const message = message_custom || 'La Semaine Spéciale commence dans une semaine. Vérifiez vos ateliers et vos disponibilités.';
        
        let count = 0;
        for (const ens of enseignants) {
            await notifyEnseignant(ens.id, 'rappel_semaine', titre, message, '/enseignants.html');
            count++;
        }
        
        res.json({ 
            success: true, 
            message: `${count} enseignants notifiés`,
            count: count
        });
        
    } catch (error) {
        console.error('Erreur rappel semaine:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/notifications/admin/broadcast-enseignants
 * Envoyer une notification à tous les enseignants
 */
router.post('/admin/broadcast-enseignants', adminMiddleware, async (req, res) => {
    try {
        const { titre, message } = req.body;
        
        if (!titre || !message) {
            return res.status(400).json({ success: false, message: 'Titre et message requis' });
        }
        
        const enseignants = await query(`
            SELECT id FROM utilisateurs 
            WHERE role = 'enseignant' AND actif = TRUE
        `);
        
        let count = 0;
        for (const ens of enseignants) {
            await notifyEnseignant(ens.id, 'broadcast', titre, message);
            count++;
        }
        
        res.json({ success: true, message: `${count} enseignants notifiés`, count });
        
    } catch (error) {
        console.error('Erreur broadcast:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/notifications/admin/broadcast-eleves
 * Envoyer une notification à tous les élèves
 */
router.post('/admin/broadcast-eleves', adminMiddleware, async (req, res) => {
    try {
        const { titre, message, classes } = req.body;
        
        if (!titre || !message) {
            return res.status(400).json({ success: false, message: 'Titre et message requis' });
        }
        
        let sql = 'SELECT id FROM eleves';
        const params = [];
        
        if (classes && classes.length > 0) {
            sql += ` WHERE classe_id IN (${classes.map(() => '?').join(',')})`;
            params.push(...classes);
        }
        
        const eleves = await query(sql, params);
        
        let count = 0;
        for (const eleve of eleves) {
            await notifyEleve(eleve.id, 'broadcast', titre, message);
            count++;
        }
        
        res.json({ success: true, message: `${count} élèves notifiés`, count });
        
    } catch (error) {
        console.error('Erreur broadcast:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// Exporter les fonctions pour utilisation dans d'autres modules
module.exports = router;
module.exports.notifyEnseignant = notifyEnseignant;
module.exports.notifyEleve = notifyEleve;
