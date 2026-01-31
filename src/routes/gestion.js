const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const bcrypt = require('bcrypt');

router.use(authMiddleware, adminMiddleware);

// ========== ENSEIGNANTS ==========
router.get('/enseignants', async (req, res) => {
    try {
        const enseignants = await query(`
            SELECT u.id, u.acronyme, u.nom, u.prenom, u.email,
                COALESCE(u.charge_max, 0) as charge_max,
                COUNT(DISTINCT a.id) as nombre_ateliers
            FROM utilisateurs u
            LEFT JOIN ateliers a ON (u.acronyme = a.enseignant_acronyme 
                OR u.acronyme = a.enseignant2_acronyme 
                OR u.acronyme = a.enseignant3_acronyme) AND a.statut != 'annule'
            WHERE u.role = 'enseignant'
            GROUP BY u.id ORDER BY u.nom, u.prenom
        `);
        res.json({ success: true, data: enseignants });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

router.post('/enseignants', async (req, res) => {
    try {
        const { acronyme, nom, prenom, email, charge_max } = req.body;
        if (!acronyme || !nom || !prenom) {
            return res.status(400).json({ success: false, message: 'Acronyme, nom et prénom requis' });
        }
        const existing = await query('SELECT id FROM utilisateurs WHERE acronyme = ?', [acronyme]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Cet acronyme existe déjà' });
        }
        const defaultPassword = req.body.mot_de_passe || acronyme;
        const hashedPassword = await bcrypt.hash(defaultPassword, 10);
        await query(`INSERT INTO utilisateurs (acronyme, nom, prenom, email, mot_de_passe, role, charge_max)
            VALUES (?, ?, ?, ?, ?, 'enseignant', ?)`,
            [acronyme, nom, prenom, email, hashedPassword, parseInt(charge_max) || 0]);
        res.json({ success: true, message: `Enseignant créé. Mot de passe: ${defaultPassword}`, default_password: defaultPassword });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// Modifier un enseignant
router.put('/enseignant/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nom, prenom, email, charge_max } = req.body;
        
        await query(`UPDATE utilisateurs SET 
            nom = COALESCE(?, nom), 
            prenom = COALESCE(?, prenom), 
            email = ?,
            charge_max = ?
            WHERE id = ? AND role = 'enseignant'`,
            [nom, prenom, email || null, parseInt(charge_max) || 0, id]);
        
        res.json({ success: true, message: 'Enseignant modifié' });
    } catch (error) {
        console.error('Erreur modification enseignant:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// Récupérer les disponibilités d'un enseignant
router.get('/enseignant/:id/disponibilites', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Récupérer l'acronyme
        const user = await query('SELECT acronyme FROM utilisateurs WHERE id = ?', [id]);
        if (user.length === 0) {
            return res.status(404).json({ success: false, message: 'Enseignant non trouvé' });
        }
        const acronyme = user[0].acronyme;
        
        // Récupérer les disponibilités
        const disponibilites = await query(`
            SELECT creneau_id, disponible 
            FROM disponibilites_enseignants 
            WHERE enseignant_acronyme = ?
        `, [acronyme]);
        
        res.json({ success: true, data: disponibilites });
    } catch (error) {
        console.error('Erreur disponibilités:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// Modifier une disponibilité
router.put('/enseignant/:id/disponibilite', async (req, res) => {
    try {
        const { id } = req.params;
        const { creneau_id, disponible } = req.body;
        
        // Récupérer l'acronyme
        const user = await query('SELECT acronyme FROM utilisateurs WHERE id = ?', [id]);
        if (user.length === 0) {
            return res.status(404).json({ success: false, message: 'Enseignant non trouvé' });
        }
        const acronyme = user[0].acronyme;
        
        // Upsert la disponibilité
        await query(`
            INSERT INTO disponibilites_enseignants (enseignant_acronyme, creneau_id, disponible)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE disponible = ?
        `, [acronyme, creneau_id, disponible, disponible]);
        
        res.json({ success: true, message: 'Disponibilité mise à jour' });
    } catch (error) {
        console.error('Erreur modification disponibilité:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// Modifier toutes les disponibilités d'un enseignant
router.put('/enseignant/:id/disponibilites/all', async (req, res) => {
    try {
        const { id } = req.params;
        const { disponible } = req.body;
        
        // Récupérer l'acronyme
        const user = await query('SELECT acronyme FROM utilisateurs WHERE id = ?', [id]);
        if (user.length === 0) {
            return res.status(404).json({ success: false, message: 'Enseignant non trouvé' });
        }
        const acronyme = user[0].acronyme;
        
        // Récupérer tous les créneaux
        const creneaux = await query('SELECT id FROM creneaux');
        
        // Supprimer les anciennes disponibilités
        await query('DELETE FROM disponibilites_enseignants WHERE enseignant_acronyme = ?', [acronyme]);
        
        // Insérer les nouvelles
        for (const c of creneaux) {
            await query(`
                INSERT INTO disponibilites_enseignants (enseignant_acronyme, creneau_id, disponible)
                VALUES (?, ?, ?)
            `, [acronyme, c.id, disponible]);
        }
        
        res.json({ success: true, message: `Toutes les disponibilités mises à ${disponible ? 'disponible' : 'indisponible'}` });
    } catch (error) {
        console.error('Erreur modification disponibilités:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ========== ELEVES ==========
router.get('/eleves', async (req, res) => {
    try {
        const { classe_id } = req.query;
        let whereClause = '';
        let params = [];
        if (classe_id) { whereClause = 'WHERE e.classe_id = ?'; params.push(classe_id); }
        const eleves = await query(`
            SELECT u.id as utilisateur_id, e.id, e.numero_eleve, u.nom, u.prenom, u.acronyme as login, 
                c.id as classe_id, c.nom as classe_nom
            FROM eleves e
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes c ON e.classe_id = c.id
            ${whereClause} ORDER BY c.nom, u.nom, u.prenom
        `, params);
        res.json({ success: true, data: eleves });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

router.post('/eleves', async (req, res) => {
    try {
        const { nom, prenom, classe_id, numero_eleve } = req.body;
        if (!nom || !prenom || !classe_id) {
            return res.status(400).json({ success: false, message: 'Nom, prénom et classe requis' });
        }
        
        // Générer l'identifiant: prenomnom (sans accents, minuscules)
        const normalizeString = (str) => str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
        const baseLogin = normalizeString(prenom) + normalizeString(nom);
        
        // Vérifier si l'identifiant existe déjà
        let login = baseLogin;
        let counter = 1;
        while (true) {
            const existing = await query('SELECT id FROM utilisateurs WHERE acronyme = ?', [login]);
            if (existing.length === 0) break;
            counter++;
            login = baseLogin + counter;
        }
        
        // Mot de passe = même que login
        const defaultPassword = await bcrypt.hash(login, 10);
        
        const result = await query(`INSERT INTO utilisateurs (acronyme, nom, prenom, mot_de_passe, role) VALUES (?, ?, ?, ?, 'eleve')`,
            [login, nom, prenom, defaultPassword]);
        await query(`INSERT INTO eleves (utilisateur_id, classe_id, numero_eleve) VALUES (?, ?, ?)`,
            [result.insertId, classe_id, numero_eleve || null]);
        res.json({ success: true, message: `Élève ajouté (identifiant: ${login})`, data: { login } });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

router.put('/eleves/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nom, prenom, classe_id } = req.body;
        
        // Récupérer l'utilisateur_id de l'élève
        const eleve = await query('SELECT utilisateur_id FROM eleves WHERE id = ?', [id]);
        if (eleve.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        
        // Mettre à jour l'utilisateur
        await query('UPDATE utilisateurs SET nom = COALESCE(?, nom), prenom = COALESCE(?, prenom) WHERE id = ?',
            [nom, prenom, eleve[0].utilisateur_id]);
        
        // Mettre à jour la classe si fournie
        if (classe_id) {
            await query('UPDATE eleves SET classe_id = ? WHERE id = ?', [classe_id, id]);
        }
        
        res.json({ success: true, message: 'Élève modifié' });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

router.delete('/eleves/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Récupérer l'utilisateur_id de l'élève
        const eleve = await query('SELECT utilisateur_id FROM eleves WHERE id = ?', [id]);
        if (eleve.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        
        // Supprimer l'utilisateur (cascade supprimera l'élève et ses inscriptions)
        await query('DELETE FROM utilisateurs WHERE id = ?', [eleve[0].utilisateur_id]);
        
        res.json({ success: true, message: 'Élève supprimé' });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ========== CLASSES ==========
router.get('/classes', async (req, res) => {
    try {
        const classes = await query(`
            SELECT c.id, c.nom, c.niveau, COUNT(e.id) as nombre_eleves
            FROM classes c LEFT JOIN eleves e ON c.id = e.classe_id
            GROUP BY c.id ORDER BY c.nom
        `);
        res.json({ success: true, data: classes });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

router.post('/classes', async (req, res) => {
    try {
        const { nom, niveau } = req.body;
        if (!nom) { return res.status(400).json({ success: false, message: 'Nom de classe requis' }); }
        await query(`INSERT INTO classes (nom, niveau) VALUES (?, ?)`, [nom, niveau || null]);
        res.json({ success: true, message: 'Classe ajoutée' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: 'Cette classe existe déjà' });
        }
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

router.put('/classes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nom, niveau } = req.body;
        await query('UPDATE classes SET nom = COALESCE(?, nom), niveau = ? WHERE id = ?', [nom, niveau || null, id]);
        res.json({ success: true, message: 'Classe modifiée' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: 'Ce nom de classe existe déjà' });
        }
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

router.delete('/classes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        // Supprimer les élèves de cette classe d'abord (cascade)
        const eleves = await query('SELECT utilisateur_id FROM eleves WHERE classe_id = ?', [id]);
        for (const e of eleves) {
            await query('DELETE FROM utilisateurs WHERE id = ?', [e.utilisateur_id]);
        }
        await query('DELETE FROM classes WHERE id = ?', [id]);
        res.json({ success: true, message: 'Classe et ses élèves supprimés' });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ========== SALLES ==========
router.get('/salles', async (req, res) => {
    try {
        const salles = await query(`SELECT * FROM salles ORDER BY nom`);
        res.json({ success: true, data: salles });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

router.post('/salles', async (req, res) => {
    try {
        const { nom, capacite, type_salle, batiment, equipement } = req.body;
        if (!nom) { return res.status(400).json({ success: false, message: 'Nom de salle requis' }); }
        await query(`INSERT INTO salles (nom, capacite, type_salle, batiment, equipement, disponible) VALUES (?, ?, ?, ?, ?, TRUE)`,
            [nom, capacite || 25, type_salle || null, batiment || null, equipement || null]);
        res.json({ success: true, message: 'Salle ajoutée' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: 'Cette salle existe déjà' });
        }
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

router.put('/salles/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nom, capacite, type_salle, batiment, equipement, disponible } = req.body;
        await query(`UPDATE salles SET nom = COALESCE(?, nom), capacite = COALESCE(?, capacite),
            type_salle = ?, batiment = ?, equipement = ?, disponible = COALESCE(?, disponible) WHERE id = ?`,
            [nom, capacite, type_salle, batiment, equipement, disponible, id]);
        res.json({ success: true, message: 'Salle modifiée' });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

router.delete('/salles/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Vérifier si la salle est utilisée dans le planning
        const planning = await query('SELECT COUNT(*) as count FROM planning WHERE salle_id = ?', [id]);
        if (planning[0].count > 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Cette salle est utilisée dans le planning. Retirez-la du planning avant de la supprimer.' 
            });
        }
        
        await query('DELETE FROM salles WHERE id = ?', [id]);
        res.json({ success: true, message: 'Salle supprimée' });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ========== ATELIERS PLANIFIÉS (pour inscriptions) ==========
router.get('/ateliers-planifies', async (req, res) => {
    try {
        const { search } = req.query;
        let whereClause = "WHERE a.statut = 'valide'";
        let params = [];
        
        if (search) {
            whereClause += " AND (a.nom LIKE ? OR c.jour LIKE ?)";
            params.push(`%${search}%`, `%${search}%`);
        }
        
        const ateliers = await query(`
            SELECT p.id as planning_id, a.id as atelier_id, a.nom as atelier_nom, a.nombre_places_max,
                c.id as creneau_id, c.jour, c.periode, s.nom as salle_nom,
                (SELECT COUNT(*) FROM inscriptions WHERE planning_id = p.id AND statut = 'confirmee') as nb_inscrits
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            ${whereClause}
            ORDER BY a.nom, c.ordre
        `, params);
        res.json({ success: true, data: ateliers });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ========== INSCRIPTIONS PAR CRÉNEAU ==========
router.post('/inscriptions-classe', async (req, res) => {
    try {
        const { planning_id, classe_id } = req.body;
        if (!planning_id || !classe_id) {
            return res.status(400).json({ success: false, message: 'Planning et classe requis' });
        }
        const plannings = await query('SELECT p.*, a.nombre_places_max, a.id as atelier_id FROM planning p JOIN ateliers a ON p.atelier_id = a.id WHERE p.id = ?', [planning_id]);
        if (plannings.length === 0) {
            return res.status(404).json({ success: false, message: 'Créneau non trouvé' });
        }
        const planning = plannings[0];
        const eleves = await query('SELECT id FROM eleves WHERE classe_id = ?', [classe_id]);
        
        if (eleves.length === 0) {
            return res.status(400).json({ success: false, message: 'Aucun élève dans cette classe' });
        }
        
        let inscrit = 0;
        let conflits = [];
        for (const eleve of eleves) {
            const existingSameCreneau = await query('SELECT id FROM inscriptions WHERE eleve_id = ? AND planning_id = ? AND statut != "annulee"', [eleve.id, planning_id]);
            if (existingSameCreneau.length > 0) continue;
            
            const conflitHoraire = await query(`
                SELECT a.nom FROM inscriptions i
                JOIN planning p ON i.planning_id = p.id
                JOIN ateliers a ON p.atelier_id = a.id
                WHERE i.eleve_id = ? AND p.creneau_id = ? AND i.statut != 'annulee' AND p.id != ?
            `, [eleve.id, planning.creneau_id, planning_id]);
            
            if (conflitHoraire.length > 0) {
                conflits.push({ eleve_id: eleve.id, conflit: conflitHoraire[0].nom });
                continue;
            }
            
            // Tenter l'insertion avec inscription_manuelle, sinon sans
            try {
                await query(`INSERT INTO inscriptions (eleve_id, atelier_id, planning_id, statut, inscription_manuelle) VALUES (?, ?, ?, 'confirmee', TRUE)`,
                    [eleve.id, planning.atelier_id, planning_id]);
            } catch (insertError) {
                // Si la colonne n'existe pas, insérer sans
                if (insertError.code === 'ER_BAD_FIELD_ERROR') {
                    await query(`INSERT INTO inscriptions (eleve_id, atelier_id, planning_id, statut) VALUES (?, ?, ?, 'confirmee')`,
                        [eleve.id, planning.atelier_id, planning_id]);
                } else {
                    throw insertError;
                }
            }
            inscrit++;
        }
        res.json({ success: true, message: `${inscrit} élèves inscrits`, data: { inscrit, conflits } });
    } catch (error) {
        console.error('Erreur inscriptions-classe:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur: ' + error.message });
    }
});

router.post('/inscriptions-eleves', async (req, res) => {
    try {
        const { planning_id, eleve_ids } = req.body;
        if (!planning_id || !Array.isArray(eleve_ids) || eleve_ids.length === 0) {
            return res.status(400).json({ success: false, message: 'Planning et liste d\'élèves requis' });
        }
        const plannings = await query('SELECT p.*, a.nombre_places_max, a.nom as atelier_nom, a.id as atelier_id FROM planning p JOIN ateliers a ON p.atelier_id = a.id WHERE p.id = ?', [planning_id]);
        if (plannings.length === 0) {
            return res.status(404).json({ success: false, message: 'Créneau non trouvé' });
        }
        const planning = plannings[0];
        
        let inscrit = 0;
        let conflits = [];
        for (const eleveId of eleve_ids) {
            const existingSameCreneau = await query('SELECT id FROM inscriptions WHERE eleve_id = ? AND planning_id = ? AND statut != "annulee"', [eleveId, planning_id]);
            if (existingSameCreneau.length > 0) continue;
            
            const conflitHoraire = await query(`
                SELECT a.nom, u.nom as eleve_nom, u.prenom as eleve_prenom FROM inscriptions i
                JOIN planning p ON i.planning_id = p.id
                JOIN ateliers a ON p.atelier_id = a.id
                JOIN eleves e ON i.eleve_id = e.id
                JOIN utilisateurs u ON e.utilisateur_id = u.id
                WHERE i.eleve_id = ? AND p.creneau_id = ? AND i.statut != 'annulee' AND p.id != ?
            `, [eleveId, planning.creneau_id, planning_id]);
            
            if (conflitHoraire.length > 0) {
                conflits.push({ eleve: `${conflitHoraire[0].eleve_prenom} ${conflitHoraire[0].eleve_nom}`, conflit: conflitHoraire[0].nom });
                continue;
            }
            
            // Tenter l'insertion avec inscription_manuelle, sinon sans
            try {
                await query(`INSERT INTO inscriptions (eleve_id, atelier_id, planning_id, statut, inscription_manuelle) VALUES (?, ?, ?, 'confirmee', TRUE)`,
                    [eleveId, planning.atelier_id, planning_id]);
            } catch (insertError) {
                if (insertError.code === 'ER_BAD_FIELD_ERROR') {
                    await query(`INSERT INTO inscriptions (eleve_id, atelier_id, planning_id, statut) VALUES (?, ?, ?, 'confirmee')`,
                        [eleveId, planning.atelier_id, planning_id]);
                } else {
                    throw insertError;
                }
            }
            inscrit++;
        }
        res.json({ success: true, message: `${inscrit} élèves inscrits à "${planning.atelier_nom}"`, data: { inscrit, conflits } });
    } catch (error) {
        console.error('Erreur inscriptions-eleves:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur: ' + error.message });
    }
});

// ========== CRÉNEAUX FAIBLES ==========
router.get('/creneaux-faibles', async (req, res) => {
    try {
        const { seuil = 5 } = req.query;
        const creneaux = await query(`
            SELECT p.id as planning_id, a.id as atelier_id, a.nom as atelier_nom, a.nombre_places_max,
                c.jour, c.periode, s.nom as salle_nom,
                (SELECT COUNT(*) FROM inscriptions WHERE planning_id = p.id AND statut = 'confirmee') as nb_inscrits,
                a.nombre_places_max - (SELECT COUNT(*) FROM inscriptions WHERE planning_id = p.id AND statut = 'confirmee') as places_restantes
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            WHERE a.statut = 'valide'
            HAVING nb_inscrits < ?
            ORDER BY nb_inscrits ASC, c.ordre
        `, [parseInt(seuil)]);
        res.json({ success: true, data: creneaux });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ========== ÉLÈVES PAR CRÉNEAU ==========
router.get('/eleves-par-creneau/:planningId', async (req, res) => {
    try {
        const { planningId } = req.params;
        const planningInfo = await query(`
            SELECT p.id as planning_id, a.nom as atelier_nom, a.nombre_places_max, c.jour, c.periode, s.nom as salle_nom
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            WHERE p.id = ?
        `, [planningId]);
        if (planningInfo.length === 0) {
            return res.status(404).json({ success: false, message: 'Créneau non trouvé' });
        }
        const eleves = await query(`
            SELECT i.id as inscription_id, e.id as eleve_id, u.nom, u.prenom, cl.nom as classe_nom, i.inscription_manuelle, i.statut
            FROM inscriptions i
            JOIN eleves e ON i.eleve_id = e.id
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes cl ON e.classe_id = cl.id
            WHERE i.planning_id = ? AND i.statut = 'confirmee'
            ORDER BY cl.nom, u.nom, u.prenom
        `, [planningId]);
        res.json({ success: true, data: { planning: planningInfo[0], eleves: eleves, total: eleves.length } });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

router.get('/tous-eleves-creneaux', async (req, res) => {
    try {
        const { jour, classe_id } = req.query;
        let whereClause = "WHERE i.statut = 'confirmee'";
        let params = [];
        if (jour) { whereClause += ' AND c.jour = ?'; params.push(jour); }
        if (classe_id) { whereClause += ' AND cl.id = ?'; params.push(classe_id); }
        
        const inscriptions = await query(`
            SELECT i.id as inscription_id, e.id as eleve_id, u.nom as eleve_nom, u.prenom as eleve_prenom, cl.nom as classe_nom,
                p.id as planning_id, a.nom as atelier_nom, c.jour, c.periode, s.nom as salle_nom
            FROM inscriptions i
            JOIN eleves e ON i.eleve_id = e.id
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes cl ON e.classe_id = cl.id
            JOIN planning p ON i.planning_id = p.id
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            ${whereClause}
            ORDER BY cl.nom, u.nom, u.prenom, c.ordre
        `, params);
        res.json({ success: true, data: inscriptions });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ========== PIQUET / DÉGAGEMENT (CORRIGÉ - SANS salle_id) ==========
router.get('/piquet', async (req, res) => {
    try {
        // Essayer d'abord avec commentaire
        let piquet;
        try {
            piquet = await query(`
                SELECT ep.id, ep.utilisateur_id, ep.creneau_id, ep.type, ep.commentaire,
                    u.nom as enseignant_nom, u.prenom as enseignant_prenom, u.acronyme as enseignant_acronyme,
                    c.jour, c.periode, c.heure_debut, c.heure_fin
                FROM enseignants_piquet ep
                JOIN utilisateurs u ON ep.utilisateur_id = u.id
                JOIN creneaux c ON ep.creneau_id = c.id
                ORDER BY c.ordre, u.nom
            `);
        } catch (e) {
            // Si erreur (colonne commentaire n'existe pas), requête sans commentaire
            if (e.code === 'ER_BAD_FIELD_ERROR') {
                piquet = await query(`
                    SELECT ep.id, ep.utilisateur_id, ep.creneau_id, ep.type, NULL as commentaire,
                        u.nom as enseignant_nom, u.prenom as enseignant_prenom, u.acronyme as enseignant_acronyme,
                        c.jour, c.periode, c.heure_debut, c.heure_fin
                    FROM enseignants_piquet ep
                    JOIN utilisateurs u ON ep.utilisateur_id = u.id
                    JOIN creneaux c ON ep.creneau_id = c.id
                    ORDER BY c.ordre, u.nom
                `);
                // Tenter d'ajouter la colonne
                try {
                    await query('ALTER TABLE enseignants_piquet ADD COLUMN commentaire TEXT');
                    console.log('Colonne commentaire ajoutée à enseignants_piquet');
                } catch (alterError) {
                    // Ignore si la colonne existe déjà ou autre erreur
                }
            } else {
                throw e;
            }
        }
        res.json({ success: true, data: piquet });
    } catch (error) {
        console.error('Erreur liste piquet:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur: ' + error.message });
    }
});

router.post('/piquet', async (req, res) => {
    try {
        const { utilisateur_id, creneau_id, type, commentaire } = req.body;
        
        console.log('Données reçues piquet:', { utilisateur_id, creneau_id, type, commentaire });
        
        if (!utilisateur_id || !creneau_id) {
            return res.status(400).json({ success: false, message: 'Enseignant et créneau requis' });
        }
        
        // Vérifier que l'enseignant existe
        const enseignant = await query('SELECT id, nom, prenom FROM utilisateurs WHERE id = ?', [utilisateur_id]);
        if (enseignant.length === 0) {
            return res.status(404).json({ success: false, message: 'Enseignant non trouvé' });
        }
        
        // Vérifier que le créneau existe
        const creneau = await query('SELECT id, jour, periode FROM creneaux WHERE id = ?', [creneau_id]);
        if (creneau.length === 0) {
            return res.status(404).json({ success: false, message: 'Créneau non trouvé' });
        }
        
        // Vérifier si déjà existant
        const existing = await query('SELECT id FROM enseignants_piquet WHERE utilisateur_id = ? AND creneau_id = ?', [utilisateur_id, creneau_id]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Cet enseignant est déjà affecté sur ce créneau' });
        }
        
        // Essayer d'insérer avec commentaire
        try {
            await query(`INSERT INTO enseignants_piquet (utilisateur_id, creneau_id, type, commentaire) VALUES (?, ?, ?, ?)`,
                [utilisateur_id, creneau_id, type || 'piquet', commentaire || null]);
        } catch (insertError) {
            if (insertError.code === 'ER_BAD_FIELD_ERROR') {
                // Colonne commentaire n'existe pas, insérer sans
                await query(`INSERT INTO enseignants_piquet (utilisateur_id, creneau_id, type) VALUES (?, ?, ?)`,
                    [utilisateur_id, creneau_id, type || 'piquet']);
                // Tenter d'ajouter la colonne pour la prochaine fois
                try {
                    await query('ALTER TABLE enseignants_piquet ADD COLUMN commentaire TEXT');
                } catch (e) {}
            } else {
                throw insertError;
            }
        }
        
        res.json({ success: true, message: `${type === 'degagement' ? 'Dégagement' : 'Piquet'} ajouté pour ${enseignant[0].prenom} ${enseignant[0].nom}` });
    } catch (error) {
        console.error('Erreur ajout piquet:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur: ' + error.message });
    }
});

router.delete('/piquet/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await query('DELETE FROM enseignants_piquet WHERE id = ?', [id]);
        res.json({ success: true, message: 'Entrée supprimée' });
    } catch (error) {
        console.error('Erreur suppression piquet:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ========== GESTION INSCRIPTIONS ÉLÈVES (ADMIN) ==========

/**
 * GET /api/gestion/recherche-eleve
 * Rechercher un élève
 */
router.get('/recherche-eleve', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 2) {
            return res.json({ success: true, data: [] });
        }
        
        const eleves = await query(`
            SELECT e.id as eleve_id, u.id as utilisateur_id, u.nom, u.prenom, 
                c.nom as classe_nom, e.inscriptions_validees
            FROM eleves e
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes c ON e.classe_id = c.id
            WHERE u.nom LIKE ? OR u.prenom LIKE ?
            ORDER BY u.nom, u.prenom
            LIMIT 20
        `, [`%${q}%`, `%${q}%`]);
        
        res.json({ success: true, data: eleves });
    } catch (error) {
        console.error('Erreur recherche:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/gestion/eleve/:eleveId/inscriptions
 * Inscriptions d'un élève
 */
router.get('/eleve/:eleveId/inscriptions', async (req, res) => {
    try {
        const { eleveId } = req.params;
        
        // Info élève
        const eleve = await query(`
            SELECT e.id, e.inscriptions_validees, e.date_validation,
                u.nom, u.prenom, c.nom as classe_nom
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
            SELECT i.id as inscription_id, i.planning_id, i.statut, i.inscription_manuelle,
                a.id as atelier_id, a.nom as atelier_nom, a.duree,
                c.jour, c.periode, s.nom as salle_nom
            FROM inscriptions i
            JOIN planning p ON i.planning_id = p.id
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            WHERE i.eleve_id = ? AND i.statut = 'confirmee'
            ORDER BY c.ordre
        `, [eleveId]);
        
        res.json({ success: true, data: { eleve: eleve[0], inscriptions } });
    } catch (error) {
        console.error('Erreur inscriptions élève:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * DELETE /api/gestion/inscription/:inscriptionId
 * Supprimer une inscription (admin)
 */
router.delete('/inscription/:inscriptionId', async (req, res) => {
    try {
        const { inscriptionId } = req.params;
        const { notifier, message } = req.body;
        
        // Récupérer l'inscription
        const inscription = await query(`
            SELECT i.*, e.id as eleve_id, a.nom as atelier_nom
            FROM inscriptions i
            JOIN eleves e ON i.eleve_id = e.id
            JOIN planning p ON i.planning_id = p.id
            JOIN ateliers a ON p.atelier_id = a.id
            WHERE i.id = ?
        `, [inscriptionId]);
        
        if (inscription.length === 0) {
            return res.status(404).json({ success: false, message: 'Inscription non trouvée' });
        }
        
        // Supprimer
        await query('DELETE FROM inscriptions WHERE id = ?', [inscriptionId]);
        
        // Créer notification si demandé
        if (notifier) {
            await query(`
                INSERT INTO notifications_eleves (eleve_id, type, message)
                VALUES (?, 'modification', ?)
            `, [inscription[0].eleve_id, message || `Votre inscription à "${inscription[0].atelier_nom}" a été modifiée par l'administration.`]);
        }
        
        res.json({ success: true, message: 'Inscription supprimée' });
    } catch (error) {
        console.error('Erreur suppression inscription:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/gestion/eleve/:eleveId/devalider
 * Dé-valider les inscriptions d'un élève (lui permettre de modifier)
 */
router.put('/eleve/:eleveId/devalider', async (req, res) => {
    try {
        const { eleveId } = req.params;
        const { notifier, message } = req.body;
        
        const eleve = await query('SELECT id, inscriptions_validees FROM eleves WHERE id = ?', [eleveId]);
        if (eleve.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        
        await query('UPDATE eleves SET inscriptions_validees = FALSE, date_validation = NULL WHERE id = ?', [eleveId]);
        
        // Notification
        if (notifier !== false) {
            await query(`
                INSERT INTO notifications_eleves (eleve_id, type, message)
                VALUES (?, 'devalidation', ?)
            `, [eleveId, message || 'Vos inscriptions ont été dé-validées. Vous pouvez à nouveau les modifier.']);
        }
        
        res.json({ success: true, message: 'Inscriptions dé-validées' });
    } catch (error) {
        console.error('Erreur dé-validation:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/gestion/eleve/:eleveId/inscription
 * Ajouter une inscription pour un élève (admin)
 */
router.post('/eleve/:eleveId/inscription', async (req, res) => {
    try {
        const { eleveId } = req.params;
        const { planning_id, notifier } = req.body;
        
        // Vérifier élève
        const eleve = await query('SELECT id FROM eleves WHERE id = ?', [eleveId]);
        if (eleve.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        
        // Vérifier planning
        const planning = await query(`
            SELECT p.*, a.nom as atelier_nom, a.nombre_places_max, c.jour, c.periode
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            WHERE p.id = ?
        `, [planning_id]);
        
        if (planning.length === 0) {
            return res.status(404).json({ success: false, message: 'Créneau non trouvé' });
        }
        
        // Vérifier si déjà inscrit
        const existing = await query('SELECT id FROM inscriptions WHERE eleve_id = ? AND planning_id = ?', [eleveId, planning_id]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Déjà inscrit à ce créneau' });
        }
        
        // Inscrire
        await query(`
            INSERT INTO inscriptions (eleve_id, atelier_id, planning_id, statut, inscription_manuelle)
            VALUES (?, ?, ?, 'confirmee', TRUE)
        `, [eleveId, planning[0].atelier_id, planning_id]);
        
        // Notification
        if (notifier !== false) {
            const jour = planning[0].jour.charAt(0).toUpperCase() + planning[0].jour.slice(1);
            await query(`
                INSERT INTO notifications_eleves (eleve_id, type, message)
                VALUES (?, 'inscription', ?)
            `, [eleveId, `Vous avez été inscrit(e) à "${planning[0].atelier_nom}" (${jour} ${planning[0].periode}) par l'administration.`]);
        }
        
        res.json({ success: true, message: `Inscrit à "${planning[0].atelier_nom}"` });
    } catch (error) {
        console.error('Erreur inscription admin:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ========== RESET MOT DE PASSE ==========

/**
 * PUT /api/gestion/enseignant/:id/reset-password
 * Réinitialiser le mot de passe d'un enseignant
 */
router.put('/enseignant/:id/reset-password', async (req, res) => {
    try {
        const { id } = req.params;
        
        const users = await query('SELECT acronyme, nom, prenom FROM utilisateurs WHERE id = ? AND role = "enseignant"', [id]);
        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'Enseignant non trouvé' });
        }
        
        const user = users[0];
        const newPassword = user.acronyme.toLowerCase(); // Mot de passe = acronyme en minuscules
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        await query('UPDATE utilisateurs SET mot_de_passe = ? WHERE id = ?', [hashedPassword, id]);
        
        await query('INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'RESET_PASSWORD', `Reset mdp enseignant ${user.acronyme}`]);
        
        res.json({ 
            success: true, 
            message: `Mot de passe réinitialisé pour ${user.prenom} ${user.nom}`,
            new_password: newPassword
        });
    } catch (error) {
        console.error('Erreur reset password:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/gestion/eleve/:id/reset-password
 * Réinitialiser le mot de passe d'un élève
 */
router.put('/eleve/:eleveId/reset-password', async (req, res) => {
    try {
        const { eleveId } = req.params;
        
        const eleves = await query(`
            SELECT e.id, u.id as utilisateur_id, u.acronyme, u.nom, u.prenom 
            FROM eleves e 
            JOIN utilisateurs u ON e.utilisateur_id = u.id 
            WHERE e.id = ?
        `, [eleveId]);
        
        if (eleves.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        
        const eleve = eleves[0];
        const newPassword = 'eleve2026'; // Mot de passe par défaut pour les élèves
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        await query('UPDATE utilisateurs SET mot_de_passe = ? WHERE id = ?', [hashedPassword, eleve.utilisateur_id]);
        
        await query('INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'RESET_PASSWORD', `Reset mdp élève ${eleve.prenom} ${eleve.nom}`]);
        
        res.json({ 
            success: true, 
            message: `Mot de passe réinitialisé pour ${eleve.prenom} ${eleve.nom}`,
            new_password: newPassword
        });
    } catch (error) {
        console.error('Erreur reset password élève:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/gestion/reset-all-passwords
 * Réinitialiser tous les mots de passe (enseignants et élèves)
 */
router.put('/reset-all-passwords', async (req, res) => {
    try {
        const { type } = req.body; // 'enseignants', 'eleves', ou 'tous'
        
        let countEns = 0, countEleves = 0;
        
        if (type === 'enseignants' || type === 'tous') {
            const enseignants = await query('SELECT id, acronyme FROM utilisateurs WHERE role = "enseignant"');
            for (const ens of enseignants) {
                const hashedPassword = await bcrypt.hash(ens.acronyme.toLowerCase(), 10);
                await query('UPDATE utilisateurs SET mot_de_passe = ? WHERE id = ?', [hashedPassword, ens.id]);
                countEns++;
            }
        }
        
        if (type === 'eleves' || type === 'tous') {
            const hashedPassword = await bcrypt.hash('eleve2026', 10);
            const result = await query('UPDATE utilisateurs SET mot_de_passe = ? WHERE role = "eleve"', [hashedPassword]);
            countEleves = result.affectedRows || 0;
        }
        
        await query('INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'RESET_ALL_PASSWORDS', `Reset mdp: ${countEns} enseignants, ${countEleves} élèves`]);
        
        res.json({ 
            success: true, 
            message: `Mots de passe réinitialisés: ${countEns} enseignants, ${countEleves} élèves`
        });
    } catch (error) {
        console.error('Erreur reset all passwords:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ========== INSCRIPTIONS PAR CLASSE (ouvrir/fermer) ==========

/**
 * PUT /api/gestion/classes/:id/inscriptions
 * Ouvrir/fermer inscriptions pour une classe
 */
router.put('/classes/:id/inscriptions', async (req, res) => {
    try {
        const { id } = req.params;
        const { ouvertes } = req.body;
        
        await query('UPDATE classes SET inscriptions_ouvertes = ? WHERE id = ?', [ouvertes ? 1 : 0, id]);
        res.json({ success: true, message: ouvertes ? 'Inscriptions ouvertes' : 'Inscriptions fermées' });
    } catch (error) {
        console.error('Erreur toggle classe:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/gestion/classes/inscriptions/toutes
 * Ouvrir/fermer inscriptions pour toutes les classes
 */
router.put('/classes/inscriptions/toutes', async (req, res) => {
    try {
        const { ouvertes } = req.body;
        
        await query('UPDATE classes SET inscriptions_ouvertes = ?', [ouvertes ? 1 : 0]);
        res.json({ success: true, message: ouvertes ? 'Inscriptions ouvertes pour toutes les classes' : 'Inscriptions fermées pour toutes les classes' });
    } catch (error) {
        console.error('Erreur toggle toutes:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

module.exports = router;
