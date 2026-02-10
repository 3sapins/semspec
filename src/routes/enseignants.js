const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authMiddleware, enseignantMiddleware } = require('../middleware/auth');
const bcrypt = require('bcrypt');

router.use(authMiddleware, enseignantMiddleware);

/**
 * GET /api/enseignants/profil
 * Profil de l'enseignant connecté
 */
router.get('/profil', async (req, res) => {
    try {
        const userId = req.user.id;
        
        const user = await query(`
            SELECT id, acronyme, nom, prenom, email, charge_max
            FROM utilisateurs WHERE id = ?
        `, [userId]);
        
        if (user.length === 0) {
            return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
        }
        
        // Calculer la charge actuelle
        const chargeActuelle = await query(`
            SELECT COALESCE(SUM(a.duree), 0) as charge
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            WHERE a.enseignant_acronyme = ? OR a.enseignant2_acronyme = ? OR a.enseignant3_acronyme = ?
        `, [user[0].acronyme, user[0].acronyme, user[0].acronyme]);
        
        // Compter les notifications non lues
        let nbNotifications = 0;
        try {
            const notifs = await query(`
                SELECT COUNT(*) as total FROM notifications_enseignants
                WHERE utilisateur_id = ? AND lue = FALSE
            `, [userId]);
            nbNotifications = notifs[0]?.total || 0;
        } catch (e) {
            // Table n'existe pas encore, ignorer
        }
        
        res.json({ 
            success: true, 
            data: {
                ...user[0],
                charge_actuelle: chargeActuelle[0]?.charge || 0,
                nb_notifications: nbNotifications
            }
        });
    } catch (error) {
        console.error('Erreur profil:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/enseignants/notifications
 * Liste des notifications de l'enseignant
 */
router.get('/notifications', async (req, res) => {
    try {
        const userId = req.user.id;
        
        const notifications = await query(`
            SELECT id, type, titre, message, lien, data, lue, created_at
            FROM notifications_enseignants
            WHERE utilisateur_id = ?
            ORDER BY created_at DESC
            LIMIT 50
        `, [userId]);
        
        res.json({ success: true, data: notifications });
    } catch (error) {
        console.error('Erreur notifications:', error);
        // Si la table n'existe pas, retourner vide
        if (error.code === 'ER_NO_SUCH_TABLE') {
            return res.json({ success: true, data: [] });
        }
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/enseignants/notifications/:id/lue
 * Marquer une notification comme lue
 */
router.put('/notifications/:id/lue', async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;
        
        await query(`
            UPDATE notifications_enseignants 
            SET lue = TRUE, read_at = NOW()
            WHERE id = ? AND utilisateur_id = ?
        `, [id, userId]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/enseignants/notifications/lire-toutes
 * Marquer toutes les notifications comme lues
 */
router.put('/notifications/lire-toutes', async (req, res) => {
    try {
        const userId = req.user.id;
        
        await query(`
            UPDATE notifications_enseignants 
            SET lue = TRUE, read_at = NOW()
            WHERE utilisateur_id = ? AND lue = FALSE
        `, [userId]);
        
        res.json({ success: true, message: 'Toutes les notifications marquées comme lues' });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/enseignants/mot-de-passe
 * Changer son mot de passe
 */
router.put('/mot-de-passe', async (req, res) => {
    try {
        const userId = req.user.id;
        const { ancien_mot_de_passe, nouveau_mot_de_passe } = req.body;
        
        if (!ancien_mot_de_passe || !nouveau_mot_de_passe) {
            return res.status(400).json({ success: false, message: 'Ancien et nouveau mot de passe requis' });
        }
        
        if (nouveau_mot_de_passe.length < 4) {
            return res.status(400).json({ success: false, message: 'Le nouveau mot de passe doit faire au moins 4 caractères' });
        }
        
        // Vérifier l'ancien mot de passe
        const user = await query('SELECT mot_de_passe FROM utilisateurs WHERE id = ?', [userId]);
        if (user.length === 0) {
            return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
        }
        
        const validPassword = await bcrypt.compare(ancien_mot_de_passe, user[0].mot_de_passe);
        if (!validPassword) {
            return res.status(400).json({ success: false, message: 'Ancien mot de passe incorrect' });
        }
        
        // Hasher et enregistrer le nouveau
        const hashedPassword = await bcrypt.hash(nouveau_mot_de_passe, 10);
        await query('UPDATE utilisateurs SET mot_de_passe = ? WHERE id = ?', [hashedPassword, userId]);
        
        res.json({ success: true, message: 'Mot de passe modifié avec succès' });
    } catch (error) {
        console.error('Erreur changement mot de passe:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/enseignants/ma-charge
 * Charge actuelle de l'enseignant
 */
router.get('/ma-charge', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        
        // Charge max définie
        const user = await query('SELECT charge_max FROM utilisateurs WHERE acronyme = ?', [acronyme]);
        const chargeMax = user[0]?.charge_max || 0;
        
        // Charge actuelle (ateliers placés dans le planning)
        const chargeActuelle = await query(`
            SELECT COALESCE(SUM(a.duree), 0) as charge
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            WHERE a.enseignant_acronyme = ? OR a.enseignant2_acronyme = ? OR a.enseignant3_acronyme = ?
        `, [acronyme, acronyme, acronyme]);
        
        // Détail par atelier
        const detail = await query(`
            SELECT a.id, a.nom, a.duree, c.jour, c.periode
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            WHERE a.enseignant_acronyme = ? OR a.enseignant2_acronyme = ? OR a.enseignant3_acronyme = ?
            ORDER BY c.ordre
        `, [acronyme, acronyme, acronyme]);
        
        res.json({ 
            success: true, 
            data: {
                charge_max: chargeMax,
                charge_actuelle: chargeActuelle[0]?.charge || 0,
                detail: detail
            }
        });
    } catch (error) {
        console.error('Erreur charge:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/enseignants/presences/:planningId
 * Liste des élèves avec statut de présence pour un créneau
 */
router.get('/presences/:planningId', async (req, res) => {
    try {
        const { planningId } = req.params;
        const acronyme = req.user.acronyme;
        
        // Vérifier que c'est bien un atelier de cet enseignant
        const planning = await query(`
            SELECT p.id, p.creneau_id, a.id as atelier_id, a.nom as atelier_nom, 
                c.jour, c.periode, s.nom as salle_nom
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            WHERE p.id = ? AND (a.enseignant_acronyme = ? OR a.enseignant2_acronyme = ? OR a.enseignant3_acronyme = ?)
        `, [planningId, acronyme, acronyme, acronyme]);
        
        if (planning.length === 0) {
            return res.status(404).json({ success: false, message: 'Créneau non trouvé ou non autorisé' });
        }
        
        // Liste des élèves inscrits avec leur statut de présence
        const eleves = await query(`
            SELECT 
                e.id as eleve_id,
                u.nom, u.prenom,
                cl.nom as classe_nom,
                COALESCE(pr.statut, 'non_pointe') as presence_statut,
                pr.commentaire as presence_commentaire,
                pr.id as presence_id
            FROM inscriptions i
            JOIN eleves e ON i.eleve_id = e.id
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes cl ON e.classe_id = cl.id
            LEFT JOIN presences pr ON pr.eleve_id = e.id AND pr.atelier_id = ? AND pr.creneau_id = ?
            WHERE i.planning_id = ? AND i.statut = 'confirmee'
            ORDER BY cl.nom, u.nom, u.prenom
        `, [planning[0].atelier_id, planning[0].creneau_id, planningId]);
        
        res.json({ 
            success: true, 
            data: {
                planning: planning[0],
                eleves: eleves
            }
        });
    } catch (error) {
        console.error('Erreur presences:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/enseignants/presences/:planningId
 * Enregistrer/modifier les présences
 */
router.post('/presences/:planningId', async (req, res) => {
    try {
        const { planningId } = req.params;
        const { presences } = req.body; // [{eleve_id, statut, commentaire}, ...]
        const acronyme = req.user.acronyme;
        
        if (!Array.isArray(presences)) {
            return res.status(400).json({ success: false, message: 'Liste de présences requise' });
        }
        
        // Vérifier que c'est bien un atelier de cet enseignant
        const planning = await query(`
            SELECT p.id, p.creneau_id, a.id as atelier_id
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            WHERE p.id = ? AND (a.enseignant_acronyme = ? OR a.enseignant2_acronyme = ? OR a.enseignant3_acronyme = ?)
        `, [planningId, acronyme, acronyme, acronyme]);
        
        if (planning.length === 0) {
            return res.status(404).json({ success: false, message: 'Créneau non trouvé ou non autorisé' });
        }
        
        const atelierId = planning[0].atelier_id;
        const creneauId = planning[0].creneau_id;
        
        // Enregistrer chaque présence
        for (const p of presences) {
            if (!p.eleve_id || !p.statut) continue;
            
            // Upsert présence
            const existing = await query(
                'SELECT id FROM presences WHERE eleve_id = ? AND atelier_id = ? AND creneau_id = ?',
                [p.eleve_id, atelierId, creneauId]
            );
            
            if (existing.length > 0) {
                await query(
                    'UPDATE presences SET statut = ?, commentaire = ? WHERE id = ?',
                    [p.statut, p.commentaire || null, existing[0].id]
                );
            } else {
                await query(
                    'INSERT INTO presences (eleve_id, atelier_id, creneau_id, statut, commentaire) VALUES (?, ?, ?, ?, ?)',
                    [p.eleve_id, atelierId, creneauId, p.statut, p.commentaire || null]
                );
            }
        }
        
        res.json({ success: true, message: 'Présences enregistrées' });
    } catch (error) {
        console.error('Erreur enregistrement presences:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

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
 * Inclut les ateliers ET les piquets/dégagements
 */
router.get('/mon-horaire', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        const userId = req.user.id;
        
        console.log(`[mon-horaire] Chargement pour ${acronyme} (userId: ${userId})`);
        
        // Ateliers de l'enseignant
        const horaire = await query(`
            SELECT p.id as planning_id, p.creneau_id, p.nombre_creneaux,
                a.id as atelier_id, a.nom as atelier_nom, a.duree, a.nombre_places_max,
                c.jour, c.periode, c.ordre, s.nom as salle_nom,
                'atelier' as type,
                (SELECT COUNT(*) FROM inscriptions WHERE planning_id = p.id AND statut = 'confirmee') as nb_inscrits
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            WHERE a.enseignant_acronyme = ? OR a.enseignant2_acronyme = ? OR a.enseignant3_acronyme = ?
            ORDER BY c.ordre
        `, [acronyme, acronyme, acronyme]);
        
        console.log(`[mon-horaire] ${horaire.length} ateliers trouvés`);
        
        // Piquets et dégagements de l'enseignant (avec fallback si colonne commentaire n'existe pas)
        let piquets = [];
        try {
            piquets = await query(`
                SELECT ep.id, ep.creneau_id, ep.type, ep.commentaire,
                    c.jour, c.periode, c.ordre,
                    'Salle des maîtres' as salle_nom
                FROM enseignants_piquet ep
                JOIN creneaux c ON ep.creneau_id = c.id
                WHERE ep.utilisateur_id = ?
                ORDER BY c.ordre
            `, [userId]);
        } catch (e) {
            if (e.code === 'ER_BAD_FIELD_ERROR') {
                // Colonne commentaire n'existe pas
                piquets = await query(`
                    SELECT ep.id, ep.creneau_id, ep.type, NULL as commentaire,
                        c.jour, c.periode, c.ordre,
                        'Salle des maîtres' as salle_nom
                    FROM enseignants_piquet ep
                    JOIN creneaux c ON ep.creneau_id = c.id
                    WHERE ep.utilisateur_id = ?
                    ORDER BY c.ordre
                `, [userId]);
            } else {
                console.error('[mon-horaire] Erreur piquets:', e);
            }
        }
        
        console.log(`[mon-horaire] ${piquets.length} piquets/dégagements trouvés`);
        
        // Combiner les deux
        const combined = [
            ...horaire,
            ...piquets.map(p => ({
                planning_id: null,
                creneau_id: p.creneau_id,
                nombre_creneaux: 1,
                atelier_id: null,
                atelier_nom: p.type === 'piquet' ? '🚨 Piquet' : '📋 Dégagement',
                duree: 2,
                nombre_places_max: null,
                jour: p.jour,
                periode: p.periode,
                ordre: p.ordre,
                salle_nom: p.salle_nom,
                type: p.type,
                nb_inscrits: null,
                commentaire: p.commentaire
            }))
        ].sort((a, b) => a.ordre - b.ordre);
        
        console.log(`[mon-horaire] Total combiné: ${combined.length} éléments`);
        
        const creneaux = await query('SELECT * FROM creneaux ORDER BY ordre');
        
        res.json({ success: true, data: { ateliers: combined, creneaux: creneaux } });
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
 * GET /api/enseignants/atelier/:id
 * Obtenir un atelier spécifique (pour modification)
 */
router.get('/atelier/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const acronyme = req.user.acronyme;
        
        const atelier = await query(`
            SELECT a.*, t.nom as theme_nom, t.couleur as theme_couleur
            FROM ateliers a
            LEFT JOIN themes t ON a.theme_id = t.id
            WHERE a.id = ? AND (a.enseignant_acronyme = ? OR a.enseignant2_acronyme = ? OR a.enseignant3_acronyme = ?)
        `, [id, acronyme, acronyme, acronyme]);
        
        if (atelier.length === 0) {
            return res.status(404).json({ success: false, message: 'Atelier non trouvé ou non autorisé' });
        }
        
        res.json({ success: true, data: atelier[0] });
    } catch (error) {
        console.error('Erreur atelier:', error);
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
 * OPTIMISÉ : Une seule requête avec GROUP_CONCAT
 */
router.get('/catalogue', async (req, res) => {
    try {
        // Requête unique avec agrégation des créneaux
        const ateliers = await query(`
            SELECT 
                a.id, a.nom, a.description, a.duree, a.nombre_places_max, a.informations_eleves,
                a.enseignant_acronyme, a.enseignant2_acronyme, a.enseignant3_acronyme,
                t.id as theme_id, t.nom as theme_nom, t.couleur as theme_couleur, t.icone as theme_icone,
                u.nom as enseignant_nom, u.prenom as enseignant_prenom,
                GROUP_CONCAT(
                    DISTINCT CONCAT_WS('|', c.jour, c.periode, COALESCE(s.nom, ''), COALESCE(
                        (SELECT COUNT(*) FROM inscriptions i WHERE i.planning_id = p.id AND i.statut = 'confirmee'), 0
                    ))
                    ORDER BY c.ordre
                    SEPARATOR ';'
                ) as creneaux_raw
            FROM ateliers a
            LEFT JOIN themes t ON a.theme_id = t.id
            LEFT JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            LEFT JOIN planning p ON p.atelier_id = a.id
            LEFT JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            WHERE a.statut = 'valide'
            GROUP BY a.id
            ORDER BY t.nom, a.nom
        `);
        
        // Parser les créneaux côté JS
        ateliers.forEach(atelier => {
            if (atelier.creneaux_raw) {
                atelier.creneaux = atelier.creneaux_raw.split(';').map(c => {
                    const [jour, periode, salle, nb_inscrits] = c.split('|');
                    return { jour, periode, salle: salle || null, nb_inscrits: parseInt(nb_inscrits) || 0 };
                });
            } else {
                atelier.creneaux = [];
            }
            delete atelier.creneaux_raw;
        });
        
        const themes = await query('SELECT * FROM themes ORDER BY nom');
        
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
            'SELECT creneau_id, disponible FROM disponibilites_enseignants WHERE enseignant_acronyme = ?',
            [acronyme]
        );
        
        const dispoMap = {};
        disponibilites.forEach(d => {
            dispoMap[d.creneau_id] = d.disponible;
        });
        
        const result = creneaux.map(c => ({
            ...c,
            disponible: dispoMap[c.id] || false
        }));
        
        res.json({ success: true, data: { creneaux: result, valide: false } });
    } catch (error) {
        console.error('Erreur disponibilités:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/enseignants/disponibilites
 * CORRIGÉ - Schéma simple sans colonne valide
 */
router.put('/disponibilites', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        const { disponibilites } = req.body;
        
        console.log('PUT disponibilites reçu:', { acronyme, nb: disponibilites?.length });
        
        if (!Array.isArray(disponibilites)) {
            return res.status(400).json({ success: false, message: 'Format invalide' });
        }
        
        // Supprimer les anciennes
        await query('DELETE FROM disponibilites_enseignants WHERE enseignant_acronyme = ?', [acronyme]);
        
        // Insérer les nouvelles
        for (const dispo of disponibilites) {
            await query(`
                INSERT INTO disponibilites_enseignants 
                (enseignant_acronyme, creneau_id, disponible)
                VALUES (?, ?, ?)
            `, [acronyme, dispo.creneau_id, dispo.disponible ? 1 : 0]);
        }
        
        res.json({ success: true, message: 'Disponibilités enregistrées' });
    } catch (error) {
        console.error('Erreur mise à jour disponibilités:', error);
        res.status(500).json({ success: false, message: 'Erreur: ' + error.message });
    }
});

/**
 * GET /api/enseignants/types-salles
 * Récupère les types de salles (depuis la table types_salles et les salles existantes)
 */
router.get('/types-salles', async (req, res) => {
    try {
        // Essayer d'abord la table types_salles
        let types = [];
        try {
            const typesTable = await query('SELECT nom FROM types_salles ORDER BY nom');
            types = typesTable.map(t => t.nom);
        } catch (e) {
            // Table n'existe pas, on continue
        }
        
        // Ajouter les types depuis les salles existantes
        const typesSalles = await query(`
            SELECT DISTINCT type_salle FROM salles 
            WHERE type_salle IS NOT NULL AND type_salle != ''
            ORDER BY type_salle
        `);
        typesSalles.forEach(t => {
            if (!types.includes(t.type_salle)) {
                types.push(t.type_salle);
            }
        });
        
        types.sort();
        res.json({ success: true, data: types });
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
            type_salle_demande, budget_max, enseignant2_acronyme, enseignant3_acronyme, remarques } = req.body;
        
        if (!nom || !duree || !nombre_places_max) {
            return res.status(400).json({ success: false, message: 'Nom, durée et places requis' });
        }
        
        const result = await query(`
            INSERT INTO ateliers (nom, description, informations_eleves, duree, nombre_places_max,
                theme_id, type_salle_demande, budget_max, enseignant_acronyme,
                enseignant2_acronyme, enseignant3_acronyme, remarques, statut)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'brouillon')
        `, [nom, description, informations_eleves, duree, nombre_places_max, theme_id || null,
            type_salle_demande || null, budget_max || 0, acronyme,
            enseignant2_acronyme || null, enseignant3_acronyme || null, remarques || null]);
        
        res.json({ success: true, message: 'Atelier créé', data: { id: result.insertId } });
    } catch (error) {
        console.error('Erreur création atelier:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur: ' + error.message });
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
            type_salle_demande, budget_max, enseignant2_acronyme, enseignant3_acronyme, remarques } = req.body;
        
        await query(`
            UPDATE ateliers SET 
                nom = ?, 
                description = ?, 
                informations_eleves = ?, 
                duree = ?,
                nombre_places_max = ?, 
                theme_id = ?, 
                type_salle_demande = ?, 
                budget_max = ?,
                enseignant2_acronyme = ?,
                enseignant3_acronyme = ?, 
                remarques = ?, 
                statut = 'brouillon'
            WHERE id = ?
        `, [nom, description, informations_eleves, duree, nombre_places_max, theme_id || null,
            type_salle_demande || null, budget_max || 0,
            enseignant2_acronyme || null, enseignant3_acronyme || null, remarques || null, id]);
        
        res.json({ success: true, message: 'Atelier modifié (retour en brouillon)' });
    } catch (error) {
        console.error('Erreur modification atelier:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur: ' + error.message });
    }
});

/**
 * PUT /api/enseignants/ateliers/:id/soumettre
 */
router.put('/ateliers/:id/soumettre', async (req, res) => {
    try {
        const { id } = req.params;
        
        console.log('=== Soumettre atelier ===');
        console.log('ID atelier:', id);
        console.log('User:', req.user);
        
        // Vérifier que l'atelier existe
        const ateliers = await query('SELECT id, nom, statut, enseignant_acronyme FROM ateliers WHERE id = ?', [id]);
        console.log('Atelier trouvé:', ateliers);
        
        if (ateliers.length === 0) {
            return res.status(404).json({ success: false, message: 'Atelier non trouvé' });
        }
        
        const atelier = ateliers[0];
        
        // Vérifier le statut
        if (atelier.statut !== 'brouillon' && atelier.statut !== 'refuse') {
            return res.status(400).json({ success: false, message: `Statut actuel: ${atelier.statut}. Seul un brouillon peut être soumis.` });
        }
        
        // Mettre à jour le statut
        await query('UPDATE ateliers SET statut = ? WHERE id = ?', ['soumis', id]);
        
        console.log('Atelier soumis avec succès');
        res.json({ success: true, message: 'Atelier soumis pour validation' });
    } catch (error) {
        console.error('=== Erreur soumission ===');
        console.error('Message:', error.message);
        console.error('Stack:', error.stack);
        res.status(500).json({ success: false, message: 'Erreur serveur: ' + error.message });
    }
});

/**
 * POST /api/enseignants/ateliers/:id/message
 * Envoyer un message aux élèves inscrits à un atelier
 */
router.post('/ateliers/:id/message', async (req, res) => {
    try {
        const { id } = req.params;
        const { titre, message } = req.body;
        const acronyme = req.user.acronyme;
        
        console.log('[Message atelier] Début - atelier:', id, 'enseignant:', acronyme);
        
        if (!titre || !message) {
            return res.status(400).json({ success: false, message: 'Titre et message requis' });
        }
        
        // Vérifier que l'enseignant a le droit (est responsable de l'atelier)
        const ateliers = await query(`
            SELECT id, nom, enseignant_acronyme, enseignant2_acronyme, enseignant3_acronyme 
            FROM ateliers WHERE id = ? AND statut = 'valide'
        `, [id]);
        
        if (ateliers.length === 0) {
            return res.status(404).json({ success: false, message: 'Atelier non trouvé ou non validé' });
        }
        
        const atelier = ateliers[0];
        const isResponsable = atelier.enseignant_acronyme === acronyme || 
                             atelier.enseignant2_acronyme === acronyme || 
                             atelier.enseignant3_acronyme === acronyme;
        
        if (!isResponsable) {
            return res.status(403).json({ success: false, message: 'Vous n\'êtes pas responsable de cet atelier' });
        }
        
        // Récupérer tous les élèves inscrits (directement via atelier_id)
        const inscrits = await query(`
            SELECT DISTINCT eleve_id
            FROM inscriptions
            WHERE atelier_id = ? AND statut = 'confirmee'
        `, [id]);
        
        console.log('[Message atelier] Inscrits trouvés:', inscrits.length, inscrits);
        
        if (inscrits.length === 0) {
            return res.status(400).json({ success: false, message: 'Aucun élève inscrit à cet atelier' });
        }
        
        // S'assurer que la table notifications_eleves existe
        try {
            await query(`
                CREATE TABLE IF NOT EXISTS notifications_eleves (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    eleve_id INT NOT NULL,
                    type VARCHAR(50) NOT NULL,
                    titre VARCHAR(200) NOT NULL,
                    message TEXT,
                    lien VARCHAR(255),
                    data JSON,
                    lue BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_eleve (eleve_id),
                    INDEX idx_lue (lue)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);
        } catch (tableError) {
            console.log('[Message atelier] Table existe déjà ou erreur:', tableError.code);
        }
        
        // Créer une notification pour chaque élève
        const titreComplet = `📬 ${atelier.nom}`;
        const messageComplet = `Message de votre enseignant :\n\n${message}`;
        
        let count = 0;
        for (const inscrit of inscrits) {
            try {
                await query(`
                    INSERT INTO notifications_eleves (eleve_id, type, titre, message, lien, data)
                    VALUES (?, 'message_enseignant', ?, ?, ?, ?)
                `, [
                    inscrit.eleve_id,
                    titreComplet,
                    messageComplet,
                    '/eleves.html',
                    JSON.stringify({ atelier_id: id, atelier_nom: atelier.nom, enseignant: acronyme })
                ]);
                count++;
            } catch (insertError) {
                console.error('[Message atelier] Erreur insertion notification:', insertError.message);
            }
        }
        
        console.log('[Message atelier] Notifications créées:', count);
        
        res.json({ 
            success: true, 
            message: `Message envoyé à ${count} élève(s)` 
        });
        
    } catch (error) {
        console.error('[Message atelier] Erreur:', error.message, error.stack);
        res.status(500).json({ success: false, message: 'Erreur serveur: ' + error.message });
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

// ===================== HORAIRES ÉLÈVES =====================

/**
 * GET /api/enseignants/classes
 * Liste des classes
 */
router.get('/classes', async (req, res) => {
    try {
        const classes = await query(`
            SELECT id, nom, niveau,
                (SELECT COUNT(*) FROM eleves WHERE classe_id = classes.id) as nb_eleves
            FROM classes
            ORDER BY niveau, nom
        `);
        res.json({ success: true, data: classes });
    } catch (error) {
        console.error('Erreur classes:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/enseignants/eleves/recherche
 * Rechercher un élève par nom/prénom
 */
router.get('/eleves/recherche', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 2) {
            return res.json({ success: true, data: [] });
        }
        
        const eleves = await query(`
            SELECT e.id, u.nom, u.prenom, c.nom as classe_nom
            FROM eleves e
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes c ON e.classe_id = c.id
            WHERE u.nom LIKE ? OR u.prenom LIKE ?
            ORDER BY u.nom, u.prenom
            LIMIT 20
        `, [`%${q}%`, `%${q}%`]);
        
        res.json({ success: true, data: eleves });
    } catch (error) {
        console.error('Erreur recherche élèves:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/enseignants/classe/:classeId/eleves
 * Liste des élèves d'une classe avec leur horaire
 */
router.get('/classe/:classeId/eleves', async (req, res) => {
    try {
        const { classeId } = req.params;
        
        const classe = await query('SELECT id, nom, niveau FROM classes WHERE id = ?', [classeId]);
        if (classe.length === 0) {
            return res.status(404).json({ success: false, message: 'Classe non trouvée' });
        }
        
        const eleves = await query(`
            SELECT e.id, u.nom, u.prenom
            FROM eleves e
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            WHERE e.classe_id = ?
            ORDER BY u.nom, u.prenom
        `, [classeId]);
        
        res.json({ success: true, data: { classe: classe[0], eleves } });
    } catch (error) {
        console.error('Erreur élèves classe:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/enseignants/eleve/:eleveId/horaire
 * Horaire d'un élève spécifique
 */
router.get('/eleve/:eleveId/horaire', async (req, res) => {
    try {
        const { eleveId } = req.params;
        
        // Info élève
        const eleve = await query(`
            SELECT e.id, u.nom, u.prenom, c.nom as classe_nom
            FROM eleves e
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes c ON e.classe_id = c.id
            WHERE e.id = ?
        `, [eleveId]);
        
        if (eleve.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        
        // Inscriptions
        const inscriptions = await query(`
            SELECT 
                i.id as inscription_id,
                a.nom as atelier_nom,
                a.duree,
                c.id as creneau_id,
                c.jour,
                c.periode,
                c.ordre,
                s.nom as salle_nom,
                COALESCE(p.nombre_creneaux, CEIL(a.duree / 2)) as nombre_creneaux,
                t.couleur as theme_couleur
            FROM inscriptions i
            JOIN planning p ON i.planning_id = p.id
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            LEFT JOIN themes t ON a.theme_id = t.id
            WHERE i.eleve_id = ? AND i.statut = 'confirmee'
            ORDER BY c.ordre
        `, [eleveId]);
        
        // Créneaux
        const creneaux = await query('SELECT * FROM creneaux ORDER BY ordre');
        
        res.json({ success: true, data: { eleve: eleve[0], inscriptions, creneaux } });
    } catch (error) {
        console.error('Erreur horaire élève:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/enseignants/catalogue-simple
 * OPTIMISÉ : Requêtes regroupées, pas de boucles N+1
 */
router.get('/catalogue-simple', async (req, res) => {
    try {
        // Récupérer tous les ateliers avec créneaux en une seule requête
        const ateliers = await query(`
            SELECT 
                a.id,
                a.nom,
                a.description,
                a.informations_eleves,
                a.duree,
                a.nombre_places_max,
                a.enseignant_acronyme,
                a.enseignant2_acronyme,
                a.enseignant3_acronyme,
                t.id as theme_id,
                t.nom as theme_nom,
                t.couleur as theme_couleur,
                t.icone as theme_icone,
                GROUP_CONCAT(
                    DISTINCT CONCAT_WS('|', c.jour, c.periode, COALESCE(s.nom, ''))
                    ORDER BY c.ordre
                    SEPARATOR ';'
                ) as creneaux_raw
            FROM ateliers a
            LEFT JOIN themes t ON a.theme_id = t.id
            LEFT JOIN planning p ON p.atelier_id = a.id
            LEFT JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            WHERE a.statut = 'valide'
            GROUP BY a.id
            ORDER BY t.nom, a.nom
        `);
        
        // Récupérer tous les enseignants en une seule requête
        const enseignantsMap = {};
        const enseignants = await query(`
            SELECT acronyme, nom, prenom FROM utilisateurs WHERE role = 'enseignant'
        `);
        enseignants.forEach(e => {
            enseignantsMap[e.acronyme] = `${e.prenom} ${e.nom}`;
        });
        
        // Parser créneaux et assembler noms enseignants côté JS
        ateliers.forEach(atelier => {
            // Créneaux
            if (atelier.creneaux_raw) {
                atelier.creneaux = atelier.creneaux_raw.split(';').map(c => {
                    const [jour, periode, salle_nom] = c.split('|');
                    return { jour, periode, salle_nom: salle_nom || null };
                });
            } else {
                atelier.creneaux = [];
            }
            delete atelier.creneaux_raw;
            
            // Noms des enseignants
            const noms = [];
            if (atelier.enseignant_acronyme && enseignantsMap[atelier.enseignant_acronyme]) {
                noms.push(enseignantsMap[atelier.enseignant_acronyme]);
            }
            if (atelier.enseignant2_acronyme && enseignantsMap[atelier.enseignant2_acronyme]) {
                noms.push(enseignantsMap[atelier.enseignant2_acronyme]);
            }
            if (atelier.enseignant3_acronyme && enseignantsMap[atelier.enseignant3_acronyme]) {
                noms.push(enseignantsMap[atelier.enseignant3_acronyme]);
            }
            atelier.enseignants = noms.join(', ') || '-';
        });
        
        const themes = await query('SELECT * FROM themes ORDER BY nom');
        
        res.json({ success: true, data: { ateliers, themes } });
    } catch (error) {
        console.error('Erreur catalogue simple:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

module.exports = router;
