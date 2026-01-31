const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authMiddleware, adminMiddleware, enseignantMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// ========== STATS (pour vérification token admin) ==========
router.get('/stats', adminMiddleware, async (req, res) => {
    try {
        const [ateliers] = await query('SELECT COUNT(*) as total FROM ateliers');
        const [enseignants] = await query('SELECT COUNT(*) as total FROM utilisateurs WHERE role = "enseignant"');
        const [eleves] = await query('SELECT COUNT(*) as total FROM utilisateurs WHERE role = "eleve"');
        const [inscriptions] = await query('SELECT COUNT(*) as total FROM inscriptions');
        
        res.json({ 
            success: true, 
            data: {
                ateliers: ateliers.total || 0,
                enseignants: enseignants.total || 0,
                eleves: eleves.total || 0,
                inscriptions: inscriptions.total || 0
            }
        });
    } catch (error) {
        console.error('Erreur stats:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

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

// ========== LISTE ENSEIGNANTS (pour création atelier admin) ==========
router.get('/enseignants/liste', adminMiddleware, async (req, res) => {
    try {
        const enseignants = await query(`
            SELECT acronyme, nom, prenom, email 
            FROM utilisateurs 
            WHERE role = 'enseignant' AND actif = TRUE
            ORDER BY nom, prenom
        `);
        res.json({ success: true, data: enseignants });
    } catch (error) {
        console.error('Erreur liste enseignants:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ========== CRÉER ATELIER (admin) ==========
router.post('/ateliers/creer', adminMiddleware, async (req, res) => {
    try {
        const {
            nom, description, theme_id, enseignant_acronyme, enseignant2_acronyme, enseignant3_acronyme,
            duree, nombre_places_max, budget_max, type_salle_demande, remarques, informations_eleves
        } = req.body;
        
        if (!nom || !duree || !nombre_places_max || !enseignant_acronyme) {
            return res.status(400).json({ success: false, message: 'Nom, durée, places et enseignant requis' });
        }
        
        // Vérifier que l'enseignant existe
        const ens = await query('SELECT acronyme FROM utilisateurs WHERE acronyme = ? AND role = "enseignant"', [enseignant_acronyme]);
        if (ens.length === 0) {
            return res.status(400).json({ success: false, message: 'Enseignant principal non trouvé' });
        }
        
        const result = await query(`
            INSERT INTO ateliers (
                nom, description, theme_id, enseignant_acronyme, enseignant2_acronyme, enseignant3_acronyme,
                duree, nombre_places_max, budget_max, type_salle_demande, remarques, informations_eleves, statut
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valide')
        `, [nom, description, theme_id || null, enseignant_acronyme, enseignant2_acronyme || null, enseignant3_acronyme || null,
            duree, nombre_places_max, budget_max || 0, type_salle_demande, remarques, informations_eleves]);
        
        await query('INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'CREATE_ADMIN', 'ateliers', result.insertId, `Création admin: ${nom}`]);
        
        res.json({ success: true, message: 'Atelier créé et validé', data: { id: result.insertId } });
    } catch (error) {
        console.error('Erreur création atelier admin:', error);
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

// ========== BUDGET ==========

/**
 * GET /api/admin/budget
 * Récapitulatif budget par atelier
 */
router.get('/budget', adminMiddleware, async (req, res) => {
    try {
        const ateliers = await query(`
            SELECT 
                a.id as atelier_id,
                a.nom as atelier_nom,
                a.duree,
                a.budget_max,
                a.enseignant_acronyme,
                COUNT(DISTINCT p.id) as nb_occurrences,
                (SELECT COUNT(*) FROM inscriptions i 
                 JOIN planning pl ON i.planning_id = pl.id 
                 WHERE pl.atelier_id = a.id AND i.statut = 'confirmee') as nb_inscrits
            FROM ateliers a
            LEFT JOIN planning p ON a.id = p.atelier_id
            WHERE a.statut = 'valide'
            GROUP BY a.id
            ORDER BY a.nom
        `);
        
        // Calculer budget total
        let budgetTotal = 0;
        ateliers.forEach(a => {
            budgetTotal += (parseFloat(a.budget_max) || 0) * (a.nb_occurrences || 1);
        });
        
        res.json({ 
            success: true, 
            data: {
                ateliers,
                budget_total: budgetTotal,
                nb_ateliers: ateliers.length
            }
        });
    } catch (error) {
        console.error('Erreur budget:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/admin/budget/:atelierId
 * Mettre à jour le budget d'un atelier
 */
router.put('/budget/:atelierId', adminMiddleware, async (req, res) => {
    try {
        const { atelierId } = req.params;
        const { budget_max } = req.body;
        
        await query('UPDATE ateliers SET budget_max = ? WHERE id = ?', [budget_max || 0, atelierId]);
        
        res.json({ success: true, message: 'Budget mis à jour' });
    } catch (error) {
        console.error('Erreur update budget:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ========== ATELIERS FAIBLE INSCRIPTION ==========

/**
 * GET /api/admin/ateliers/faible-inscription
 * Liste des ateliers avec peu d'inscrits
 */
router.get('/ateliers/faible-inscription', adminMiddleware, async (req, res) => {
    try {
        const seuil = parseInt(req.query.seuil) || 3;
        
        const ateliers = await query(`
            SELECT 
                a.id as atelier_id,
                a.nom as atelier_nom,
                a.enseignant_acronyme,
                u.nom as enseignant_nom,
                a.nombre_places_max as places_max,
                a.nombre_places_min as places_min,
                COUNT(DISTINCT i.id) as nb_inscrits,
                GROUP_CONCAT(DISTINCT CONCAT(c.jour, ' ', c.periode) SEPARATOR ', ') as creneaux
            FROM ateliers a
            LEFT JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            LEFT JOIN planning p ON a.id = p.atelier_id
            LEFT JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN inscriptions i ON p.id = i.planning_id AND i.statut = 'confirmee'
            WHERE a.statut = 'valide'
            GROUP BY a.id
            HAVING nb_inscrits < ?
            ORDER BY nb_inscrits ASC, a.nom
        `, [seuil]);
        
        // Ajouter calcul manque
        ateliers.forEach(a => {
            a.manque_pour_minimum = Math.max(0, (a.places_min || 0) - a.nb_inscrits);
        });
        
        res.json({ 
            success: true, 
            data: ateliers,
            seuil,
            total: ateliers.length
        });
    } catch (error) {
        console.error('Erreur faible inscription:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ========== CONFIGURATION / QUOTA ==========

/**
 * GET /api/admin/configuration
 * Récupérer toutes les configurations
 */
router.get('/configuration', adminMiddleware, async (req, res) => {
    try {
        // Vérifier si la table existe, sinon créer avec valeurs par défaut
        try {
            const config = await query('SELECT * FROM configuration');
            res.json({ success: true, data: config });
        } catch (e) {
            // Table n'existe pas, créer
            await query(`
                CREATE TABLE IF NOT EXISTS configuration (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    cle VARCHAR(100) UNIQUE NOT NULL,
                    valeur TEXT,
                    description VARCHAR(255)
                )
            `);
            await query(`INSERT IGNORE INTO configuration (cle, valeur, description) VALUES 
                ('quota_places_pourcent', '100', 'Pourcentage de places disponibles'),
                ('inscriptions_ouvertes', 'true', 'Inscriptions ouvertes globalement')
            `);
            const config = await query('SELECT * FROM configuration');
            res.json({ success: true, data: config });
        }
    } catch (error) {
        console.error('Erreur configuration:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/admin/configuration/quota
 * Mettre à jour le quota de places
 */
router.put('/configuration/quota', adminMiddleware, async (req, res) => {
    try {
        const { quota } = req.body;
        
        if (quota === undefined || quota < 0 || quota > 100) {
            return res.status(400).json({ success: false, message: 'Quota invalide (0-100)' });
        }
        
        // Créer la table si elle n'existe pas
        await query(`
            CREATE TABLE IF NOT EXISTS configuration (
                id INT AUTO_INCREMENT PRIMARY KEY,
                cle VARCHAR(100) UNIQUE NOT NULL,
                valeur TEXT,
                description VARCHAR(255)
            )
        `);
        
        // Upsert
        await query(`
            INSERT INTO configuration (cle, valeur, description) 
            VALUES ('quota_places_pourcent', ?, 'Pourcentage de places disponibles')
            ON DUPLICATE KEY UPDATE valeur = ?
        `, [quota.toString(), quota.toString()]);
        
        await query('INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'UPDATE_QUOTA', `Quota mis à ${quota}%`]);
        
        res.json({ success: true, message: `Quota mis à jour: ${quota}%` });
    } catch (error) {
        console.error('Erreur quota:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ========== INSCRIPTIONS PAR CLASSE ==========

/**
 * GET /api/admin/inscriptions/classes
 * Liste des classes avec statut inscriptions
 */
router.get('/inscriptions/classes', adminMiddleware, async (req, res) => {
    try {
        const classes = await query(`
            SELECT 
                c.id,
                c.nom,
                c.niveau,
                c.inscriptions_ouvertes,
                (SELECT COUNT(*) FROM eleves WHERE classe_id = c.id) as nb_eleves,
                (SELECT COUNT(*) FROM inscriptions i 
                 JOIN eleves e ON i.eleve_id = e.id 
                 WHERE e.classe_id = c.id) as nb_inscriptions
            FROM classes c
            ORDER BY c.nom
        `);
        
        res.json({ success: true, data: classes });
    } catch (error) {
        console.error('Erreur classes inscriptions:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/admin/inscriptions/classe/:id
 * Ouvrir/fermer inscriptions pour une classe
 */
router.put('/inscriptions/classe/:id', adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { ouvert } = req.body;
        
        // Vérifier que la colonne existe
        try {
            await query('UPDATE classes SET inscriptions_ouvertes = ? WHERE id = ?', [ouvert, id]);
        } catch (e) {
            // Ajouter la colonne si elle n'existe pas
            await query('ALTER TABLE classes ADD COLUMN inscriptions_ouvertes BOOLEAN DEFAULT TRUE');
            await query('UPDATE classes SET inscriptions_ouvertes = ? WHERE id = ?', [ouvert, id]);
        }
        
        res.json({ success: true, message: ouvert ? 'Inscriptions ouvertes' : 'Inscriptions fermées' });
    } catch (error) {
        console.error('Erreur toggle classe:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/admin/inscriptions/classes/toutes
 * Ouvrir/fermer inscriptions pour toutes les classes
 */
router.put('/inscriptions/classes/toutes', adminMiddleware, async (req, res) => {
    try {
        const { ouvert } = req.body;
        
        // Vérifier que la colonne existe
        try {
            await query('UPDATE classes SET inscriptions_ouvertes = ?', [ouvert]);
        } catch (e) {
            await query('ALTER TABLE classes ADD COLUMN inscriptions_ouvertes BOOLEAN DEFAULT TRUE');
            await query('UPDATE classes SET inscriptions_ouvertes = ?', [ouvert]);
        }
        
        const action = ouvert ? 'ouvertes' : 'fermées';
        
        await query('INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'TOGGLE_INSCRIPTIONS', `Inscriptions ${action} pour toutes les classes`]);
        
        res.json({ success: true, message: `Inscriptions ${action} pour toutes les classes` });
    } catch (error) {
        console.error('Erreur toggle toutes:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

module.exports = router;
