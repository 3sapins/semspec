const express = require('express');
const router = express.Router();
const { query, transaction } = require('../config/database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const bcrypt = require('bcrypt');

// Protection: authentification admin
router.use(authMiddleware, adminMiddleware);

/**
 * GET /api/gestion/enseignants
 * Liste de tous les enseignants
 */
router.get('/enseignants', async (req, res) => {
    try {
        const enseignants = await query(`
            SELECT 
                u.id,
                u.acronyme,
                u.nom,
                u.prenom,
                u.email,
                COALESCE(u.charge_max, 0) as charge_max,
                COUNT(DISTINCT a.id) as nombre_ateliers
            FROM utilisateurs u
            LEFT JOIN ateliers a ON (
                u.acronyme = a.enseignant_acronyme 
                OR u.acronyme = a.enseignant2_acronyme 
                OR u.acronyme = a.enseignant3_acronyme
            ) AND a.statut != 'annule'
            WHERE u.role = 'enseignant'
            GROUP BY u.id
            ORDER BY u.nom, u.prenom
        `);
        
        res.json({ success: true, data: enseignants });
    } catch (error) {
        console.error('Erreur liste enseignants:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/gestion/enseignants
 * Ajouter un nouvel enseignant
 */
router.post('/enseignants', async (req, res) => {
    try {
        const { acronyme, nom, prenom, email, charge_max } = req.body;
        
        if (!acronyme || !nom || !prenom) {
            return res.status(400).json({
                success: false,
                message: 'Acronyme, nom et prénom requis'
            });
        }
        
        // Vérifier que l'acronyme n'existe pas
        const existing = await query('SELECT id FROM utilisateurs WHERE acronyme = ?', [acronyme]);
        if (existing.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Cet acronyme existe déjà'
            });
        }
        
        // Mot de passe par défaut = acronyme (ou mot_de_passe du CSV si fourni)
        const defaultPassword = req.body.mot_de_passe || acronyme;
        const hashedPassword = await bcrypt.hash(defaultPassword, 10);
        
        await query(`
            INSERT INTO utilisateurs (acronyme, nom, prenom, email, mot_de_passe, role, charge_max)
            VALUES (?, ?, ?, ?, ?, 'enseignant', ?)
        `, [acronyme, nom, prenom, email, hashedPassword, parseInt(charge_max) || 0]);
        
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'CREATE_ENSEIGNANT', `Enseignant ${acronyme} créé`]
        );
        
        res.json({
            success: true,
            message: `Enseignant créé. Mot de passe: ${defaultPassword}`,
            default_password: defaultPassword
        });
    } catch (error) {
        console.error('Erreur création enseignant:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/gestion/eleves
 * Liste de tous les élèves
 */
router.get('/eleves', async (req, res) => {
    try {
        const eleves = await query(`
            SELECT 
                u.id as utilisateur_id,
                e.id as eleve_id,
                u.acronyme,
                u.nom,
                u.prenom,
                u.email,
                e.numero_eleve,
                c.nom as classe_nom,
                c.id as classe_id,
                COUNT(DISTINCT i.id) as nombre_inscriptions
            FROM utilisateurs u
            JOIN eleves e ON u.id = e.utilisateur_id
            JOIN classes c ON e.classe_id = c.id
            LEFT JOIN inscriptions i ON e.id = i.eleve_id AND i.statut = 'confirmee'
            WHERE u.role = 'eleve'
            GROUP BY e.id
            ORDER BY c.nom, u.nom, u.prenom
        `);
        
        res.json({ success: true, data: eleves });
    } catch (error) {
        console.error('Erreur liste élèves:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/gestion/eleves
 * Ajouter un nouvel élève
 */
router.post('/eleves', async (req, res) => {
    try {
        const { nom, prenom, email, classe_id, classe_nom, mot_de_passe } = req.body;
        
        if (!nom || !prenom) {
            return res.status(400).json({
                success: false,
                message: 'Nom et prénom requis'
            });
        }
        
        // Trouver la classe (par id ou par nom)
        let classeId = classe_id;
        if (!classeId && classe_nom) {
            const classes = await query('SELECT id FROM classes WHERE nom = ?', [classe_nom]);
            if (classes.length > 0) {
                classeId = classes[0].id;
            } else {
                return res.status(400).json({
                    success: false,
                    message: `Classe "${classe_nom}" non trouvée`
                });
            }
        }
        
        if (!classeId) {
            return res.status(400).json({
                success: false,
                message: 'Classe requise (classe_id ou classe_nom)'
            });
        }
        
        // Générer l'acronyme = prénomnom (sans accents, minuscules)
        const cleanPrenom = prenom.toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z]/g, '');
        const cleanNom = nom.toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z]/g, '');
        let acronyme = cleanPrenom + cleanNom;
        
        // Vérifier unicité de l'acronyme, ajouter chiffre si doublon
        let suffix = 1;
        let baseAcronyme = acronyme;
        while (true) {
            const existing = await query('SELECT id FROM utilisateurs WHERE acronyme = ?', [acronyme]);
            if (existing.length === 0) break;
            acronyme = baseAcronyme + suffix;
            suffix++;
        }
        
        // Mot de passe par défaut = acronyme (ou mot_de_passe du CSV si fourni)
        const defaultPassword = mot_de_passe || acronyme;
        const hashedPassword = await bcrypt.hash(defaultPassword, 10);
        
        // Créer l'utilisateur puis l'élève
        await transaction(async (connection) => {
            // Créer dans utilisateurs
            const [userResult] = await connection.execute(`
                INSERT INTO utilisateurs (acronyme, nom, prenom, email, mot_de_passe, role)
                VALUES (?, ?, ?, ?, ?, 'eleve')
            `, [acronyme, nom, prenom, email || null, hashedPassword]);
            
            const userId = userResult.insertId;
            
            // Créer dans eleves (liaison avec classe)
            await connection.execute(`
                INSERT INTO eleves (utilisateur_id, classe_id)
                VALUES (?, ?)
            `, [userId, classeId]);
        });
        
        // Mettre à jour le compteur d'élèves de la classe
        await query(`
            UPDATE classes SET nombre_eleves = (
                SELECT COUNT(*) FROM eleves WHERE classe_id = ?
            ) WHERE id = ?
        `, [classeId, classeId]);
        
        res.json({
            success: true,
            message: `Élève créé. Identifiant: ${acronyme} / Mot de passe: ${defaultPassword}`,
            acronyme: acronyme,
            mot_de_passe: defaultPassword
        });
    } catch (error) {
        console.error('Erreur création élève:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/gestion/classes
 * Liste de toutes les classes
 */
router.get('/classes', async (req, res) => {
    try {
        const classes = await query(`
            SELECT 
                c.id,
                c.nom,
                c.niveau,
                c.voie,
                c.annee,
                COUNT(DISTINCT e.id) as nombre_eleves
            FROM classes c
            LEFT JOIN eleves e ON c.id = e.classe_id
            GROUP BY c.id
            ORDER BY c.nom
        `);
        
        res.json({ success: true, data: classes });
    } catch (error) {
        console.error('Erreur liste classes:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/gestion/classes/:id/eleves
 * Liste des élèves d'une classe
 */
router.get('/classes/:id/eleves', async (req, res) => {
    try {
        const { id } = req.params;
        
        const eleves = await query(`
            SELECT 
                e.id as eleve_id,
                u.id as utilisateur_id,
                u.acronyme,
                u.nom,
                u.prenom,
                e.numero_eleve,
                COUNT(DISTINCT i.id) as nombre_inscriptions
            FROM eleves e
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            LEFT JOIN inscriptions i ON e.id = i.eleve_id AND i.statut = 'confirmee'
            WHERE e.classe_id = ?
            GROUP BY e.id
            ORDER BY u.nom, u.prenom
        `, [id]);
        
        res.json({ success: true, data: eleves });
    } catch (error) {
        console.error('Erreur élèves classe:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/gestion/salles
 * Liste de toutes les salles
 */
router.get('/salles', async (req, res) => {
    try {
        const salles = await query(`
            SELECT 
                s.*,
                COUNT(DISTINCT p.id) as nombre_utilisations
            FROM salles s
            LEFT JOIN planning p ON s.id = p.salle_id
            GROUP BY s.id
            ORDER BY s.batiment, s.nom
        `);
        
        res.json({ success: true, data: salles });
    } catch (error) {
        console.error('Erreur liste salles:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/gestion/salles
 * Ajouter une nouvelle salle
 */
router.post('/salles', async (req, res) => {
    try {
        const { nom, capacite, type_salle, batiment, etage, equipement } = req.body;
        
        if (!nom || !capacite) {
            return res.status(400).json({
                success: false,
                message: 'Nom et capacité requis'
            });
        }
        
        await query(`
            INSERT INTO salles (nom, capacite, type_salle, batiment, etage, equipement, disponible)
            VALUES (?, ?, ?, ?, ?, ?, TRUE)
        `, [nom, capacite, type_salle, batiment, etage, equipement]);
        
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'CREATE_SALLE', `Salle ${nom} créée`]
        );
        
        res.json({
            success: true,
            message: 'Salle créée avec succès'
        });
    } catch (error) {
        console.error('Erreur création salle:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/gestion/salles/:id
 * Modifier une salle
 */
router.put('/salles/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nom, capacite, type_salle, batiment, etage, equipement, disponible } = req.body;
        
        await query(`
            UPDATE salles SET
                nom = COALESCE(?, nom),
                capacite = COALESCE(?, capacite),
                type_salle = ?,
                batiment = ?,
                etage = ?,
                equipement = ?,
                disponible = COALESCE(?, disponible)
            WHERE id = ?
        `, [nom, capacite, type_salle, batiment, etage, equipement, disponible, id]);
        
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'UPDATE', 'salles', id, `Salle modifiée`]
        );
        
        res.json({
            success: true,
            message: 'Salle modifiée avec succès'
        });
    } catch (error) {
        console.error('Erreur modification salle:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/gestion/inscriptions-classe
 * Inscrire toute une classe à un atelier
 */
router.post('/inscriptions-classe', async (req, res) => {
    try {
        const { atelier_id, classe_id } = req.body;
        
        if (!atelier_id || !classe_id) {
            return res.status(400).json({
                success: false,
                message: 'Atelier et classe requis'
            });
        }
        
        // Récupérer le planning
        const plannings = await query(
            'SELECT id FROM planning WHERE atelier_id = ?',
            [atelier_id]
        );
        
        if (plannings.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Atelier non placé dans le planning'
            });
        }
        
        const planningId = plannings[0].id;
        
        // Récupérer les élèves de la classe
        const eleves = await query(
            'SELECT id FROM eleves WHERE classe_id = ?',
            [classe_id]
        );
        
        let inscrit = 0;
        
        for (const eleve of eleves) {
            // Vérifier si pas déjà inscrit
            const existing = await query(
                'SELECT id FROM inscriptions WHERE eleve_id = ? AND atelier_id = ? AND statut != "annulee"',
                [eleve.id, atelier_id]
            );
            
            if (existing.length === 0) {
                await query(`
                    INSERT INTO inscriptions (eleve_id, atelier_id, planning_id, statut, inscription_manuelle)
                    VALUES (?, ?, ?, 'confirmee', TRUE)
                `, [eleve.id, atelier_id, planningId]);
                inscrit++;
            }
        }
        
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'INSCRIPTION_CLASSE', `${inscrit} élèves inscrits`]
        );
        
        res.json({
            success: true,
            message: `${inscrit} élèves inscrits`,
            data: { inscrit }
        });
    } catch (error) {
        console.error('Erreur inscription classe:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/gestion/inscriptions-eleves
 * Inscrire des élèves spécifiques à un atelier
 */
router.post('/inscriptions-eleves', async (req, res) => {
    try {
        const { atelier_id, eleve_ids } = req.body;
        
        if (!atelier_id || !Array.isArray(eleve_ids)) {
            return res.status(400).json({
                success: false,
                message: 'Atelier et liste d\'élèves requis'
            });
        }
        
        // Récupérer le planning
        const plannings = await query(
            'SELECT id FROM planning WHERE atelier_id = ?',
            [atelier_id]
        );
        
        if (plannings.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Atelier non placé dans le planning'
            });
        }
        
        const planningId = plannings[0].id;
        
        let inscrit = 0;
        
        for (const eleveId of eleve_ids) {
            // Vérifier si pas déjà inscrit
            const existing = await query(
                'SELECT id FROM inscriptions WHERE eleve_id = ? AND atelier_id = ? AND statut != "annulee"',
                [eleveId, atelier_id]
            );
            
            if (existing.length === 0) {
                await query(`
                    INSERT INTO inscriptions (eleve_id, atelier_id, planning_id, statut, inscription_manuelle)
                    VALUES (?, ?, ?, 'confirmee', TRUE)
                `, [eleveId, atelier_id, planningId]);
                inscrit++;
            }
        }
        
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'INSCRIPTION_ELEVES', `${inscrit} élèves inscrits`]
        );
        
        res.json({
            success: true,
            message: `${inscrit} élèves inscrits`,
            data: { inscrit }
        });
    } catch (error) {
        console.error('Erreur inscription élèves:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

module.exports = router;

/**
 * GET /api/gestion/piquet
 * Liste des enseignants de piquet
 */
router.get('/piquet', async (req, res) => {
    try {
        const piquet = await query(`
            SELECT 
                ep.*,
                u.nom as enseignant_nom,
                u.prenom as enseignant_prenom,
                c.jour,
                c.periode,
                c.heure_debut,
                c.heure_fin,
                s.nom as salle_nom
            FROM enseignants_piquet ep
            JOIN utilisateurs u ON ep.enseignant_acronyme = u.acronyme
            JOIN creneaux c ON ep.creneau_id = c.id
            LEFT JOIN salles s ON ep.salle_id = s.id
            ORDER BY c.ordre, u.nom
        `);
        
        res.json({ success: true, data: piquet });
    } catch (error) {
        console.error('Erreur liste piquet:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/gestion/piquet
 * Ajouter un enseignant de piquet
 */
router.post('/piquet', async (req, res) => {
    try {
        const { enseignant_acronyme, creneau_id, salle_id, type } = req.body;
        
        if (!enseignant_acronyme || !creneau_id) {
            return res.status(400).json({
                success: false,
                message: 'Enseignant et créneau requis'
            });
        }
        
        await query(`
            INSERT INTO enseignants_piquet (enseignant_acronyme, creneau_id, salle_id, type)
            VALUES (?, ?, ?, ?)
        `, [enseignant_acronyme, creneau_id, salle_id || null, type || 'piquet']);
        
        res.json({ success: true, message: 'Piquet ajouté' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({
                success: false,
                message: 'Cet enseignant est déjà de piquet sur ce créneau'
            });
        }
        console.error('Erreur ajout piquet:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * DELETE /api/gestion/piquet/:id
 * Supprimer un enseignant de piquet
 */
router.delete('/piquet/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await query('DELETE FROM enseignants_piquet WHERE id = ?', [id]);
        res.json({ success: true, message: 'Piquet supprimé' });
    } catch (error) {
        console.error('Erreur suppression piquet:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});
