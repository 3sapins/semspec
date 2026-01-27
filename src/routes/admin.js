const express = require('express');
const router = express.Router();
const multer = require('multer');
const csv = require('csv-parse');
const bcrypt = require('bcrypt');
const { query, transaction } = require('../config/database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const fs = require('fs').promises;

// Configuration upload
const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10485760 } // 10MB par défaut
});

// Protection: toutes les routes admin nécessitent authentification + rôle admin
router.use(authMiddleware, adminMiddleware);

/**
 * POST /api/admin/import/salles
 * Import CSV des salles
 */
router.post('/import/salles', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Fichier CSV requis'
            });
        }

        const fileContent = await fs.readFile(req.file.path, 'utf-8');
        const records = [];

        // Parse CSV
        const parser = csv.parse(fileContent, {
            columns: true,
            skip_empty_lines: true,
            trim: true
        });

        for await (const record of parser) {
            records.push(record);
        }

        // Suppression du fichier temporaire
        await fs.unlink(req.file.path);

        let imported = 0;
        let errors = [];

        // Import des salles
        for (const record of records) {
            try {
                const disponible = record.disponible === 'TRUE' || record.disponible === '1' || record.disponible === 'true';
                
                await query(
                    `INSERT INTO salles (nom, capacite, type_salle, equipement, batiment, etage, disponible) 
                     VALUES (?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE 
                     capacite = VALUES(capacite),
                     type_salle = VALUES(type_salle),
                     equipement = VALUES(equipement),
                     batiment = VALUES(batiment),
                     etage = VALUES(etage),
                     disponible = VALUES(disponible)`,
                    [
                        record.nom,
                        parseInt(record.capacite) || 25,
                        record.type_salle || null,
                        record.equipement || null,
                        record.batiment || null,
                        record.etage || null,
                        disponible
                    ]
                );
                imported++;
            } catch (error) {
                errors.push({ salle: record.nom, error: error.message });
            }
        }

        // Log de l'action
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'IMPORT_SALLES', `${imported} salles importées`]
        );

        res.json({
            success: true,
            message: `${imported} salles importées avec succès`,
            data: {
                imported,
                total: records.length,
                errors
            }
        });

    } catch (error) {
        console.error('Erreur import salles:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de l\'import des salles',
            error: error.message
        });
    }
});

/**
 * POST /api/admin/import/enseignants
 * Import CSV des enseignants
 */
router.post('/import/enseignants', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Fichier CSV requis'
            });
        }

        const fileContent = await fs.readFile(req.file.path, 'utf-8');
        const records = [];

        const parser = csv.parse(fileContent, {
            columns: true,
            skip_empty_lines: true,
            trim: true
        });

        for await (const record of parser) {
            records.push(record);
        }

        await fs.unlink(req.file.path);

        let imported = 0;
        let errors = [];

        // Mot de passe par défaut pour les nouveaux comptes
        const defaultPassword = await bcrypt.hash('SemaineSpeciale2026', 10);

        for (const record of records) {
            try {
                await query(
                    `INSERT INTO utilisateurs (acronyme, nom, prenom, email, mot_de_passe, role) 
                     VALUES (?, ?, ?, ?, ?, 'enseignant')
                     ON DUPLICATE KEY UPDATE 
                     nom = VALUES(nom),
                     prenom = VALUES(prenom),
                     email = VALUES(email)`,
                    [
                        record.acronyme.toUpperCase(),
                        record.nom,
                        record.prenom,
                        record.email || null,
                        defaultPassword
                    ]
                );
                imported++;
            } catch (error) {
                errors.push({ acronyme: record.acronyme, error: error.message });
            }
        }

        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'IMPORT_ENSEIGNANTS', `${imported} enseignants importés`]
        );

        res.json({
            success: true,
            message: `${imported} enseignants importés avec succès`,
            data: {
                imported,
                total: records.length,
                errors,
                info: 'Mot de passe par défaut: SemaineSpeciale2026'
            }
        });

    } catch (error) {
        console.error('Erreur import enseignants:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de l\'import des enseignants'
        });
    }
});

/**
 * POST /api/admin/import/eleves
 * Import CSV des élèves
 */
router.post('/import/eleves', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Fichier CSV requis'
            });
        }

        const fileContent = await fs.readFile(req.file.path, 'utf-8');
        const records = [];

        const parser = csv.parse(fileContent, {
            columns: true,
            skip_empty_lines: true,
            trim: true
        });

        for await (const record of parser) {
            records.push(record);
        }

        await fs.unlink(req.file.path);

        let imported = 0;
        let errors = [];

        // Mot de passe par défaut pour les élèves
        const defaultPassword = await bcrypt.hash('eleve2026', 10);

        for (const record of records) {
            try {
                // Récupération de l'ID de la classe
                const classes = await query('SELECT id FROM classes WHERE nom = ?', [record.classe]);
                
                if (classes.length === 0) {
                    errors.push({ 
                        eleve: `${record.prenom} ${record.nom}`, 
                        error: `Classe ${record.classe} non trouvée` 
                    });
                    continue;
                }

                const classeId = classes[0].id;

                // Génération d'un acronyme pour l'élève (3 premières lettres du nom)
                const acronyme = `${record.nom.substring(0, 3).toUpperCase()}${record.prenom.substring(0, 2).toUpperCase()}`;

                // Création du compte utilisateur
                const result = await query(
                    `INSERT INTO utilisateurs (acronyme, nom, prenom, mot_de_passe, role) 
                     VALUES (?, ?, ?, ?, 'eleve')
                     ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
                    [acronyme, record.nom, record.prenom, defaultPassword]
                );

                const userId = result.insertId;

                // Liaison avec la classe
                await query(
                    `INSERT INTO eleves (utilisateur_id, classe_id, numero_eleve) 
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE numero_eleve = VALUES(numero_eleve)`,
                    [userId, classeId, record.numero_eleve || null]
                );

                imported++;
            } catch (error) {
                errors.push({ 
                    eleve: `${record.prenom} ${record.nom}`, 
                    error: error.message 
                });
            }
        }

        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'IMPORT_ELEVES', `${imported} élèves importés`]
        );

        res.json({
            success: true,
            message: `${imported} élèves importés avec succès`,
            data: {
                imported,
                total: records.length,
                errors,
                info: 'Mot de passe par défaut: eleve2026'
            }
        });

    } catch (error) {
        console.error('Erreur import élèves:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de l\'import des élèves'
        });
    }
});

/**
 * GET /api/admin/stats
 * Statistiques globales
 */
router.get('/stats', async (req, res) => {
    try {
        const stats = {};

        // Nombre total d'utilisateurs par rôle
        const users = await query(`
            SELECT role, COUNT(*) as count 
            FROM utilisateurs 
            WHERE actif = TRUE 
            GROUP BY role
        `);
        stats.utilisateurs = users;

        // Nombre de salles
        const salles = await query('SELECT COUNT(*) as count FROM salles WHERE disponible = TRUE');
        stats.salles = salles[0].count;

        // Nombre de classes
        const classes = await query('SELECT COUNT(*) as count FROM classes');
        stats.classes = classes[0].count;

        // Nombre d'ateliers par statut
        const ateliers = await query(`
            SELECT statut, COUNT(*) as count 
            FROM ateliers 
            GROUP BY statut
        `);
        stats.ateliers = ateliers;

        // Budget total
        const budget = await query(`
            SELECT SUM(budget_max) as total 
            FROM ateliers 
            WHERE statut = 'valide'
        `);
        stats.budget_total = budget[0].total || 0;

        // Budget maximum configuré
        const budgetMax = await query(`
            SELECT valeur FROM configuration WHERE cle = 'budget_max_global'
        `);
        stats.budget_max = parseFloat(budgetMax[0]?.valeur || 10000);

        // Nombre d'inscriptions
        const inscriptions = await query(`
            SELECT statut, COUNT(*) as count 
            FROM inscriptions 
            GROUP BY statut
        `);
        stats.inscriptions = inscriptions;

        res.json({
            success: true,
            data: stats
        });

    } catch (error) {
        console.error('Erreur stats:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération des statistiques'
        });
    }
});

/**
 * GET /api/admin/configuration
 * Récupération de la configuration
 */
router.get('/configuration', async (req, res) => {
    try {
        const config = await query('SELECT * FROM configuration');
        
        // Retourner le tableau directement pour compatibilité avec frontend
        res.json({
            success: true,
            data: config
        });

    } catch (error) {
        console.error('Erreur configuration:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération de la configuration'
        });
    }
});

/**
 * PUT /api/admin/configuration/inscriptions
 * Ouvrir/Fermer les inscriptions
 */
router.put('/configuration/inscriptions', async (req, res) => {
    try {
        const { ouvert } = req.body;
        
        await query(`
            UPDATE configuration 
            SET valeur = ? 
            WHERE cle = 'inscriptions_ouvertes'
        `, [ouvert ? 'true' : 'false']);
        
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'UPDATE_CONFIG', `Inscriptions ${ouvert ? 'ouvertes' : 'fermées'}`]
        );
        
        res.json({
            success: true,
            message: `Inscriptions ${ouvert ? 'ouvertes' : 'fermées'}`
        });
        
    } catch (error) {
        console.error('Erreur toggle inscriptions:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/admin/configuration/quota
 * Mettre à jour le quota de places disponibles
 */
router.put('/configuration/quota', async (req, res) => {
    try {
        const { quota } = req.body;
        
        if (quota === undefined || quota < 0 || quota > 100) {
            return res.status(400).json({
                success: false,
                message: 'Le quota doit être entre 0 et 100'
            });
        }
        
        await query(`
            UPDATE configuration 
            SET valeur = ? 
            WHERE cle = 'quota_places_pourcent'
        `, [quota.toString()]);
        
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'UPDATE_CONFIG', `Quota places modifié: ${quota}%`]
        );
        
        res.json({
            success: true,
            message: `Quota mis à jour: ${quota}%`
        });
        
    } catch (error) {
        console.error('Erreur mise à jour quota:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la mise à jour du quota'
        });
    }
});

/**
 * PUT /api/admin/configuration/:key
 * Modification d'une valeur de configuration (route générique - doit être après les routes spécifiques)
 */
router.put('/configuration/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const { valeur } = req.body;

        if (valeur === undefined || valeur === null) {
            return res.status(400).json({
                success: false,
                message: 'Valeur requise'
            });
        }

        await query(
            'UPDATE configuration SET valeur = ? WHERE cle = ?',
            [String(valeur), key]
        );

        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'UPDATE_CONFIG', `Configuration ${key} modifiée`]
        );

        res.json({
            success: true,
            message: 'Configuration mise à jour'
        });

    } catch (error) {
        console.error('Erreur update config:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la mise à jour de la configuration'
        });
    }
});

/**
 * GET /api/admin/ateliers
 * Liste de tous les ateliers (tous statuts)
 */
router.get('/ateliers', async (req, res) => {
    try {
        const { statut } = req.query;
        
        let whereClause = '';
        let params = [];
        
        if (statut) {
            whereClause = 'WHERE a.statut = ?';
            params.push(statut);
        }
        
        const ateliers = await query(`
            SELECT 
                a.*,
                u.nom as enseignant_nom,
                u.prenom as enseignant_prenom,
                COUNT(DISTINCT i.id) as nombre_inscrits,
                (a.nombre_places_max - COUNT(DISTINCT i.id)) as places_restantes
            FROM ateliers a
            LEFT JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            LEFT JOIN inscriptions i ON a.id = i.atelier_id AND i.statut = 'confirmee'
            ${whereClause}
            GROUP BY a.id
            ORDER BY a.date_creation DESC
        `, params);
        
        res.json({
            success: true,
            data: ateliers
        });
        
    } catch (error) {
        console.error('Erreur liste ateliers admin:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération des ateliers'
        });
    }
});

/**
 * PUT /api/admin/ateliers/:id/valider
 * Valider un atelier
 */
router.put('/ateliers/:id/valider', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Vérifier que l'atelier existe et n'est pas déjà validé
        const ateliers = await query(
            'SELECT * FROM ateliers WHERE id = ? AND statut IN ("soumis", "en_attente", "brouillon")',
            [id]
        );
        
        if (ateliers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Atelier non trouvé ou déjà validé'
            });
        }
        
        const atelier = ateliers[0];
        
        // Vérifier le budget total
        const budgetActuel = await query(`
            SELECT SUM(budget_max) as total 
            FROM ateliers 
            WHERE statut = 'valide'
        `);
        
        const budgetMax = await query(`
            SELECT valeur FROM configuration WHERE cle = 'budget_max_global'
        `);
        
        const budgetTotal = (budgetActuel[0]?.total || 0) + parseFloat(atelier.budget_max);
        const budgetMaxValue = parseFloat(budgetMax[0]?.valeur || 10000);
        
        if (budgetTotal > budgetMaxValue) {
            return res.status(400).json({
                success: false,
                message: `Budget dépassé ! Total serait: ${budgetTotal.toFixed(2)} CHF / ${budgetMaxValue} CHF`,
                budget_total: budgetTotal,
                budget_max: budgetMaxValue
            });
        }
        
        // Valider l'atelier
        await query(
            'UPDATE ateliers SET statut = "valide" WHERE id = ?',
            [id]
        );
        
        // Log
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'VALIDATE_ATELIER', 'ateliers', id, `Atelier "${atelier.nom}" validé`]
        );
        
        res.json({
            success: true,
            message: 'Atelier validé avec succès',
            budget_total: budgetTotal,
            budget_max: budgetMaxValue
        });
        
    } catch (error) {
        console.error('Erreur validation atelier:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la validation de l\'atelier'
        });
    }
});

/**
 * PUT /api/admin/ateliers/:id/refuser
 * Refuser un atelier
 */
router.put('/ateliers/:id/refuser', async (req, res) => {
    try {
        const { id } = req.params;
        const { commentaire } = req.body;
        
        const ateliers = await query(
            'SELECT * FROM ateliers WHERE id = ? AND statut = "soumis"',
            [id]
        );
        
        if (ateliers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Atelier non trouvé ou non soumis'
            });
        }
        
        const atelier = ateliers[0];
        
        // Mettre à jour le statut et ajouter le commentaire dans remarques
        let remarques = atelier.remarques || '';
        if (commentaire) {
            remarques += `\n[REFUSÉ] ${commentaire}`;
        }
        
        await query(
            'UPDATE ateliers SET statut = "refuse", remarques = ? WHERE id = ?',
            [remarques, id]
        );
        
        // Log
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'REFUSE_ATELIER', 'ateliers', id, `Atelier "${atelier.nom}" refusé: ${commentaire || 'Pas de commentaire'}`]
        );
        
        res.json({
            success: true,
            message: 'Atelier refusé'
        });
        
    } catch (error) {
        console.error('Erreur refus atelier:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors du refus de l\'atelier'
        });
    }
});

/**
 * DELETE /api/admin/ateliers/:id
 * Supprimer un atelier (admin uniquement)
 */
router.delete('/ateliers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const ateliers = await query('SELECT * FROM ateliers WHERE id = ?', [id]);
        
        if (ateliers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Atelier non trouvé'
            });
        }
        
        await query('DELETE FROM ateliers WHERE id = ?', [id]);
        
        // Log
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'DELETE', 'ateliers', id, `Atelier "${ateliers[0].nom}" supprimé par admin`]
        );
        
        res.json({
            success: true,
            message: 'Atelier supprimé avec succès'
        });
        
    } catch (error) {
        console.error('Erreur suppression atelier:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la suppression de l\'atelier'
        });
    }
});

/**
 * POST /api/admin/ateliers/:id/obligatoire
 * Marquer un atelier comme obligatoire pour certaines classes
 */
router.post('/ateliers/:id/obligatoire', async (req, res) => {
    try {
        const { id } = req.params;
        const { classes } = req.body; // Array de class IDs
        
        if (!Array.isArray(classes) || classes.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Liste de classes requise'
            });
        }
        
        // Marquer l'atelier comme obligatoire
        await query('UPDATE ateliers SET obligatoire = TRUE WHERE id = ?', [id]);
        
        // Ajouter les liaisons classe-atelier
        for (const classeId of classes) {
            await query(
                `INSERT IGNORE INTO ateliers_obligatoires (atelier_id, classe_id) VALUES (?, ?)`,
                [id, classeId]
            );
        }
        
        // Log
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'ATELIER_OBLIGATOIRE', 'ateliers', id, `Atelier obligatoire pour ${classes.length} classes`]
        );
        
        res.json({
            success: true,
            message: 'Atelier marqué comme obligatoire'
        });
        
    } catch (error) {
        console.error('Erreur atelier obligatoire:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la configuration'
        });
    }
});

/**
 * POST /api/admin/inscriptions-manuelles
 * Inscrire manuellement des élèves à un atelier
 * Vérifie les conflits d'horaire
 */
router.post('/inscriptions-manuelles', async (req, res) => {
    try {
        const { atelier_id, classe_ids, eleve_ids } = req.body;
        
        if (!atelier_id) {
            return res.status(400).json({
                success: false,
                message: 'Atelier ID requis'
            });
        }
        
        // Vérifier que l'atelier existe et récupérer ses créneaux
        const atelierInfo = await query(`
            SELECT a.id, a.nom, p.creneau_id, p.nombre_creneaux, c.jour, c.periode, c.ordre
            FROM ateliers a
            LEFT JOIN planning p ON a.id = p.atelier_id
            LEFT JOIN creneaux c ON p.creneau_id = c.id
            WHERE a.id = ?
        `, [atelier_id]);
        
        if (atelierInfo.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Atelier non trouvé'
            });
        }
        
        const atelier = atelierInfo[0];
        
        // Collecter les créneaux occupés par cet atelier
        const creneauxAtelier = [];
        if (atelier.creneau_id) {
            for (let i = 0; i < (atelier.nombre_creneaux || 1); i++) {
                creneauxAtelier.push(atelier.creneau_id + i);
            }
        }
        
        let inscrit = 0;
        let dejaInscrits = 0;
        let conflits = [];
        let errors = [];
        
        // Collecter tous les élèves à inscrire
        let elevesAInscrire = [];
        
        // Par classe
        if (classe_ids && Array.isArray(classe_ids)) {
            for (const classeId of classe_ids) {
                const eleves = await query('SELECT id, nom, prenom FROM eleves WHERE classe_id = ?', [classeId]);
                elevesAInscrire = elevesAInscrire.concat(eleves);
            }
        }
        
        // Par élève individuel
        if (eleve_ids && Array.isArray(eleve_ids)) {
            for (const eleveId of eleve_ids) {
                const eleve = await query('SELECT id, nom, prenom FROM eleves WHERE id = ?', [eleveId]);
                if (eleve.length > 0) {
                    elevesAInscrire.push(eleve[0]);
                }
            }
        }
        
        // Dédupliquer par ID
        const elevesUniques = [];
        const idsVus = new Set();
        for (const e of elevesAInscrire) {
            if (!idsVus.has(e.id)) {
                idsVus.add(e.id);
                elevesUniques.push(e);
            }
        }
        
        // Inscrire chaque élève
        for (const eleve of elevesUniques) {
            try {
                // Vérifier si pas déjà inscrit à cet atelier
                const existing = await query(
                    'SELECT id FROM inscriptions WHERE eleve_id = ? AND atelier_id = ?',
                    [eleve.id, atelier_id]
                );
                
                if (existing.length > 0) {
                    dejaInscrits++;
                    continue;
                }
                
                // Vérifier les conflits d'horaire (si l'atelier est placé)
                if (creneauxAtelier.length > 0) {
                    const placeholders = creneauxAtelier.map(() => '?').join(',');
                    const conflitHoraire = await query(`
                        SELECT a.nom as atelier_conflit
                        FROM inscriptions i
                        JOIN ateliers a ON i.atelier_id = a.id
                        JOIN planning p ON a.id = p.atelier_id
                        JOIN creneaux c ON p.creneau_id = c.id
                        WHERE i.eleve_id = ?
                        AND c.id IN (${placeholders})
                    `, [eleve.id, ...creneauxAtelier]);
                    
                    if (conflitHoraire.length > 0) {
                        conflits.push({
                            eleve: `${eleve.prenom} ${eleve.nom}`,
                            conflit: conflitHoraire[0].atelier_conflit
                        });
                        continue;
                    }
                }
                
                // Inscrire
                await query(
                    `INSERT INTO inscriptions (eleve_id, atelier_id, statut, inscription_manuelle)
                     VALUES (?, ?, 'confirmee', TRUE)`,
                    [eleve.id, atelier_id]
                );
                inscrit++;
                
            } catch (error) {
                errors.push({ eleve: `${eleve.prenom} ${eleve.nom}`, error: error.message });
            }
        }
        
        // Log
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'INSCRIPTIONS_MANUELLES', `${inscrit} élèves inscrits à "${atelier.nom}"`]
        );
        
        // Construire le message
        let message = `${inscrit} élève(s) inscrit(s)`;
        if (dejaInscrits > 0) message += `, ${dejaInscrits} déjà inscrit(s)`;
        if (conflits.length > 0) message += `, ${conflits.length} conflit(s) d'horaire`;
        
        res.json({
            success: true,
            message,
            data: { inscrit, dejaInscrits, conflits, errors }
        });
        
    } catch (error) {
        console.error('Erreur inscriptions manuelles:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors des inscriptions'
        });
    }
});

/**
 * GET /api/admin/listes/:atelierId
 * Liste des élèves inscrits à un atelier
 */
router.get('/listes/:atelierId', async (req, res) => {
    try {
        const { atelierId } = req.params;
        
        const eleves = await query(`
            SELECT 
                i.id as inscription_id,
                i.statut,
                i.inscription_manuelle,
                u.nom as eleve_nom,
                u.prenom as eleve_prenom,
                e.numero_eleve,
                c.nom as classe_nom
            FROM inscriptions i
            JOIN eleves e ON i.eleve_id = e.id
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes c ON e.classe_id = c.id
            WHERE i.atelier_id = ? AND i.statut = 'confirmee'
            ORDER BY c.nom, u.nom, u.prenom
        `, [atelierId]);
        
        res.json({
            success: true,
            data: eleves
        });
        
    } catch (error) {
        console.error('Erreur liste élèves:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération de la liste'
        });
    }
});

/**
 * GET /api/admin/ateliers/:id
 * Récupérer un atelier spécifique pour modification
 */
router.get('/ateliers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const ateliers = await query(`
            SELECT * FROM ateliers WHERE id = ?
        `, [id]);
        
        if (ateliers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Atelier non trouvé'
            });
        }
        
        res.json({
            success: true,
            data: ateliers[0]
        });
        
    } catch (error) {
        console.error('Erreur récupération atelier:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur serveur'
        });
    }
});

/**
 * POST /api/admin/ateliers/creer
 * Créer un atelier depuis l'admin avec sélection d'enseignants
 */
router.post('/ateliers/creer', async (req, res) => {
    try {
        const {
            nom,
            description,
            theme_id,
            enseignant_acronyme,
            enseignant2_acronyme,
            enseignant3_acronyme,
            duree,
            nombre_places_max,
            budget_max,
            type_salle_demande,
            remarques,
            informations_eleves
        } = req.body;
        
        // Validation
        if (!nom || !enseignant_acronyme || !duree || !nombre_places_max) {
            return res.status(400).json({
                success: false,
                message: 'Nom, enseignant principal, durée et places requis'
            });
        }
        
        if (![2, 4, 6].includes(parseInt(duree))) {
            return res.status(400).json({
                success: false,
                message: 'Durée doit être 2, 4 ou 6 périodes'
            });
        }
        
        const result = await query(`
            INSERT INTO ateliers (
                nom, description, theme_id, enseignant_acronyme, enseignant2_acronyme, enseignant3_acronyme,
                duree, nombre_places_max, budget_max, type_salle_demande, 
                remarques, informations_eleves, statut
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valide')
        `, [
            nom,
            description || null,
            theme_id || null,
            enseignant_acronyme,
            enseignant2_acronyme || null,
            enseignant3_acronyme || null,
            duree,
            nombre_places_max,
            budget_max || 0,
            type_salle_demande || null,
            remarques || null,
            informations_eleves || null
        ]);
        
        // Log
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'CREATE', 'ateliers', result.insertId, `Atelier "${nom}" créé par admin`]
        );
        
        res.json({
            success: true,
            message: 'Atelier créé avec succès',
            data: {
                id: result.insertId
            }
        });
        
    } catch (error) {
        console.error('Erreur création atelier admin:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la création de l\'atelier'
        });
    }
});

/**
 * PUT /api/admin/ateliers/:id/modifier
 * Modifier un atelier depuis l'admin
 */
router.put('/ateliers/:id/modifier', async (req, res) => {
    try {
        const { id } = req.params;
        const {
            nom,
            description,
            theme_id,
            enseignant_acronyme,
            enseignant2_acronyme,
            enseignant3_acronyme,
            duree,
            nombre_places_max,
            budget_max,
            type_salle_demande,
            remarques,
            informations_eleves
        } = req.body;
        
        // Vérifier que l'atelier existe
        const ateliers = await query('SELECT * FROM ateliers WHERE id = ?', [id]);
        if (ateliers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Atelier non trouvé'
            });
        }
        
        const atelier = ateliers[0];
        
        // Mise à jour
        await query(`
            UPDATE ateliers SET
                nom = ?,
                description = ?,
                theme_id = ?,
                enseignant_acronyme = ?,
                enseignant2_acronyme = ?,
                enseignant3_acronyme = ?,
                duree = ?,
                nombre_places_max = ?,
                budget_max = ?,
                type_salle_demande = ?,
                remarques = ?,
                informations_eleves = ?
            WHERE id = ?
        `, [
            nom || atelier.nom,
            description !== undefined ? description : atelier.description,
            theme_id !== undefined ? (theme_id || null) : atelier.theme_id,
            enseignant_acronyme || atelier.enseignant_acronyme,
            enseignant2_acronyme !== undefined ? enseignant2_acronyme : atelier.enseignant2_acronyme,
            enseignant3_acronyme !== undefined ? enseignant3_acronyme : atelier.enseignant3_acronyme,
            duree || atelier.duree,
            nombre_places_max || atelier.nombre_places_max,
            budget_max !== undefined ? budget_max : atelier.budget_max,
            type_salle_demande !== undefined ? type_salle_demande : atelier.type_salle_demande,
            remarques !== undefined ? remarques : atelier.remarques,
            informations_eleves !== undefined ? informations_eleves : atelier.informations_eleves,
            id
        ]);
        
        // Log
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'UPDATE', 'ateliers', id, `Atelier "${nom || atelier.nom}" modifié par admin`]
        );
        
        res.json({
            success: true,
            message: 'Atelier modifié avec succès'
        });
        
    } catch (error) {
        console.error('Erreur modification atelier admin:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la modification de l\'atelier'
        });
    }
});

/**
 * GET /api/admin/enseignants/liste
 * Liste simple des enseignants pour select
 */
router.get('/enseignants/liste', async (req, res) => {
    try {
        const enseignants = await query(`
            SELECT acronyme, nom, prenom
            FROM utilisateurs
            WHERE role = 'enseignant'
            ORDER BY nom, prenom
        `);
        
        res.json({ success: true, data: enseignants });
    } catch (error) {
        console.error('Erreur liste enseignants:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ============================================================
// ROUTES v5.3 : Budget, Inscriptions par Classe, Stats
// ============================================================

/**
 * GET /api/admin/budget
 * Récapitulatif du budget par atelier
 */
router.get('/budget', async (req, res) => {
    try {
        const ateliers = await query(`
            SELECT 
                a.id as atelier_id,
                a.nom as atelier_nom,
                a.budget_max,
                a.duree,
                COUNT(DISTINCT pl.creneau_id) as nb_occurrences,
                COALESCE(a.budget_max, 0) * COUNT(DISTINCT pl.creneau_id) as budget_total_atelier,
                (SELECT COUNT(*) FROM inscriptions WHERE atelier_id = a.id) as nb_inscrits
            FROM ateliers a
            LEFT JOIN planning pl ON a.id = pl.atelier_id
            WHERE a.statut = 'valide'
            GROUP BY a.id
            ORDER BY a.nom
        `);
        
        // Calcul du total
        const budgetTotal = ateliers.reduce((sum, a) => sum + parseFloat(a.budget_total_atelier || 0), 0);
        
        res.json({
            success: true,
            data: {
                ateliers,
                budget_total: budgetTotal,
                nb_ateliers: ateliers.length
            }
        });
        
    } catch (error) {
        console.error('Erreur récupération budget:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/admin/budget/:atelierId
 * Mettre à jour le budget d'un atelier
 */
router.put('/budget/:atelierId', async (req, res) => {
    try {
        const { atelierId } = req.params;
        const { budget_max } = req.body;
        
        await query(
            'UPDATE ateliers SET budget_max = ? WHERE id = ?',
            [parseFloat(budget_max) || 0, atelierId]
        );
        
        res.json({ success: true, message: 'Budget mis à jour' });
        
    } catch (error) {
        console.error('Erreur mise à jour budget:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/admin/inscriptions/classes
 * Liste des classes avec statut inscriptions
 */
router.get('/inscriptions/classes', async (req, res) => {
    try {
        const classes = await query(`
            SELECT 
                c.id,
                c.nom,
                c.niveau,
                c.inscriptions_ouvertes,
                COUNT(e.id) as nb_eleves,
                (SELECT COUNT(*) FROM inscriptions i 
                 JOIN eleves el ON i.eleve_id = el.id 
                 WHERE el.classe_id = c.id) as nb_inscriptions
            FROM classes c
            LEFT JOIN eleves e ON c.id = e.classe_id
            GROUP BY c.id
            ORDER BY c.nom
        `);
        
        res.json({ success: true, data: classes });
        
    } catch (error) {
        console.error('Erreur liste classes inscriptions:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/admin/inscriptions/classe/:classeId
 * Ouvrir/Fermer inscriptions pour une classe
 */
router.put('/inscriptions/classe/:classeId', async (req, res) => {
    try {
        const { classeId } = req.params;
        const { ouvert } = req.body;
        
        await query(
            'UPDATE classes SET inscriptions_ouvertes = ? WHERE id = ?',
            [ouvert ? 1 : 0, classeId]
        );
        
        const classe = await query('SELECT nom FROM classes WHERE id = ?', [classeId]);
        const action = ouvert ? 'ouvertes' : 'fermées';
        
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'UPDATE_INSCRIPTIONS', `Inscriptions ${action} pour ${classe[0]?.nom}`]
        );
        
        res.json({ 
            success: true, 
            message: `Inscriptions ${action} pour ${classe[0]?.nom}` 
        });
        
    } catch (error) {
        console.error('Erreur toggle inscriptions classe:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/admin/inscriptions/classes/toutes
 * Ouvrir/Fermer inscriptions pour toutes les classes
 */
router.put('/inscriptions/classes/toutes', async (req, res) => {
    try {
        const { ouvert } = req.body;
        
        await query('UPDATE classes SET inscriptions_ouvertes = ?', [ouvert ? 1 : 0]);
        
        // Aussi mettre à jour la config globale
        await query(
            "UPDATE configuration SET valeur = ? WHERE cle = 'inscriptions_ouvertes'",
            [ouvert ? 'true' : 'false']
        );
        
        const action = ouvert ? 'ouvertes' : 'fermées';
        
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'UPDATE_INSCRIPTIONS', `Inscriptions ${action} pour TOUTES les classes`]
        );
        
        res.json({ 
            success: true, 
            message: `Inscriptions ${action} pour toutes les classes` 
        });
        
    } catch (error) {
        console.error('Erreur toggle inscriptions toutes classes:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/admin/stats/creneaux
 * Stats par créneau : places totales, manquantes, inscrits
 */
router.get('/stats/creneaux', async (req, res) => {
    try {
        // Total élèves
        const totalElevesResult = await query('SELECT COUNT(*) as total FROM eleves');
        const totalEleves = totalElevesResult[0].total;
        
        // Stats par créneau
        const stats = await query(`
            SELECT 
                cr.id as creneau_id,
                cr.jour,
                cr.periode,
                cr.ordre,
                COALESCE(SUM(a.places_max), 0) as total_places,
                COUNT(DISTINCT a.id) as nb_ateliers
            FROM creneaux cr
            LEFT JOIN planning pl ON cr.id = pl.creneau_id
            LEFT JOIN ateliers a ON pl.atelier_id = a.id AND a.statut = 'valide'
            GROUP BY cr.id
            ORDER BY cr.ordre
        `);
        
        // Inscrits par créneau (éviter les doublons multi-blocs)
        for (let s of stats) {
            const inscritResult = await query(`
                SELECT COUNT(DISTINCT i.eleve_id) as inscrits
                FROM inscriptions i
                JOIN ateliers a ON i.atelier_id = a.id
                JOIN planning pl ON a.id = pl.atelier_id
                WHERE pl.creneau_id = ? AND a.statut = 'valide'
            `, [s.creneau_id]);
            
            s.total_inscrits = inscritResult[0]?.inscrits || 0;
            s.places_manquantes = Math.max(0, totalEleves - s.total_places);
            s.total_eleves = totalEleves;
        }
        
        res.json({ success: true, data: stats, total_eleves: totalEleves });
        
    } catch (error) {
        console.error('Erreur stats créneaux:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/admin/ateliers/faible-inscription
 * Ateliers avec moins de N inscrits (défaut: 3)
 */
router.get('/ateliers/faible-inscription', async (req, res) => {
    try {
        const seuil = parseInt(req.query.seuil) || 3;
        
        const ateliers = await query(`
            SELECT 
                a.id as atelier_id,
                a.nom as atelier_nom,
                a.places_min,
                a.places_max,
                a.enseignant_acronyme,
                CONCAT(u.prenom, ' ', u.nom) as enseignant_nom,
                COUNT(i.id) as nb_inscrits,
                GREATEST(0, a.places_min - COUNT(i.id)) as manque_pour_minimum,
                GROUP_CONCAT(DISTINCT CONCAT(cr.jour, ' ', cr.periode) ORDER BY cr.ordre SEPARATOR ', ') as creneaux
            FROM ateliers a
            LEFT JOIN inscriptions i ON a.id = i.atelier_id
            LEFT JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            LEFT JOIN planning pl ON a.id = pl.atelier_id
            LEFT JOIN creneaux cr ON pl.creneau_id = cr.id
            WHERE a.statut = 'valide'
            GROUP BY a.id
            HAVING COUNT(i.id) < ?
            ORDER BY nb_inscrits ASC, a.nom
        `, [seuil]);
        
        res.json({ 
            success: true, 
            data: ateliers,
            seuil: seuil,
            total: ateliers.length
        });
        
    } catch (error) {
        console.error('Erreur ateliers faible inscription:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/admin/utilisateurs/:id/reset-password
 * Réinitialiser le mot de passe d'un utilisateur (enseignant ou élève)
 * Le nouveau mot de passe = acronyme pour enseignants, prénomnom pour élèves
 */
router.put('/utilisateurs/:id/reset-password', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Récupérer l'utilisateur
        const users = await query('SELECT * FROM utilisateurs WHERE id = ?', [id]);
        
        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Utilisateur non trouvé'
            });
        }
        
        const user = users[0];
        let newPassword;
        
        if (user.role === 'enseignant') {
            // Mot de passe = acronyme
            newPassword = user.acronyme;
        } else if (user.role === 'eleve') {
            // Mot de passe = prénomnom en minuscule sans accents
            const cleanPrenom = user.prenom.toLowerCase()
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z]/g, '');
            const cleanNom = user.nom.toLowerCase()
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z]/g, '');
            newPassword = cleanPrenom + cleanNom;
        } else {
            return res.status(400).json({
                success: false,
                message: 'Impossible de réinitialiser le mot de passe admin'
            });
        }
        
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        await query('UPDATE utilisateurs SET mot_de_passe = ? WHERE id = ?', [hashedPassword, id]);
        
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'RESET_PASSWORD', `Mot de passe réinitialisé pour ${user.acronyme}`]
        );
        
        res.json({
            success: true,
            message: `Mot de passe réinitialisé`,
            nouveau_mot_de_passe: newPassword,
            utilisateur: {
                id: user.id,
                acronyme: user.acronyme,
                nom: user.nom,
                prenom: user.prenom,
                role: user.role
            }
        });
        
    } catch (error) {
        console.error('Erreur reset password:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/admin/enseignants/:acronyme/disponibilites
 * Récupérer les disponibilités d'un enseignant
 */
router.get('/enseignants/:acronyme/disponibilites', async (req, res) => {
    try {
        const { acronyme } = req.params;
        
        const disponibilites = await query(
            'SELECT * FROM disponibilites_enseignants WHERE enseignant_acronyme = ?',
            [acronyme]
        );
        
        res.json({
            success: true,
            data: disponibilites
        });
    } catch (error) {
        console.error('Erreur get disponibilités:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/admin/enseignants/:acronyme/disponibilites
 * Mettre à jour les disponibilités d'un enseignant
 */
router.put('/enseignants/:acronyme/disponibilites', async (req, res) => {
    try {
        const { acronyme } = req.params;
        const { indisponibilites } = req.body; // Array des creneau_id où l'enseignant est INdisponible
        
        // Supprimer les anciennes entrées
        await query('DELETE FROM disponibilites_enseignants WHERE enseignant_acronyme = ?', [acronyme]);
        
        // Insérer les nouvelles indisponibilités
        if (indisponibilites && indisponibilites.length > 0) {
            const values = indisponibilites.map(creneauId => [acronyme, creneauId, false]);
            await query(
                'INSERT INTO disponibilites_enseignants (enseignant_acronyme, creneau_id, disponible) VALUES ?',
                [values]
            );
        }
        
        // Log dans historique
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'UPDATE_DISPONIBILITES', `Disponibilités mises à jour pour ${acronyme}`]
        );
        
        res.json({
            success: true,
            message: 'Disponibilités enregistrées'
        });
    } catch (error) {
        console.error('Erreur update disponibilités:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

module.exports = router;
