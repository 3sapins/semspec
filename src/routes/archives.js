/**
 * Routes Archives - Gestion multi-année
 */
const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// Toutes les routes nécessitent une authentification admin
router.use(authMiddleware, adminMiddleware);

/**
 * GET /api/archives
 * Liste des archives
 */
router.get('/', async (req, res) => {
    try {
        const archives = await query(`
            SELECT * FROM archives ORDER BY annee DESC
        `);
        res.json({ success: true, data: archives });
    } catch (error) {
        console.error('Erreur liste archives:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/archives/:id
 * Détails d'une archive
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const archives = await query('SELECT * FROM archives WHERE id = ?', [id]);
        if (archives.length === 0) {
            return res.status(404).json({ success: false, message: 'Archive non trouvée' });
        }
        
        const ateliers = await query(`
            SELECT * FROM archives_ateliers WHERE archive_id = ? ORDER BY theme_nom, nom
        `, [id]);
        
        res.json({ 
            success: true, 
            data: {
                archive: archives[0],
                ateliers
            }
        });
    } catch (error) {
        console.error('Erreur détails archive:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/archives/config/annee-courante
 * Récupérer l'année courante
 */
router.get('/config/annee-courante', async (req, res) => {
    try {
        const config = await query("SELECT valeur FROM configuration WHERE cle = 'annee_courante'");
        const annee = config.length > 0 ? parseInt(config[0].valeur) : new Date().getFullYear();
        res.json({ success: true, data: { annee } });
    } catch (error) {
        console.error('Erreur config:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/archives/cloturer
 * Clôturer l'année et créer une archive
 * OPTIMISÉ : Requêtes groupées, insertion en batch
 */
router.post('/cloturer', async (req, res) => {
    try {
        const { annee, nom, commentaire, nouvelleAnnee } = req.body;
        
        if (!annee || !nom) {
            return res.status(400).json({ success: false, message: 'Année et nom requis' });
        }
        
        // Vérifier qu'une archive n'existe pas déjà pour cette année
        const existing = await query('SELECT id FROM archives WHERE annee = ?', [annee]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Une archive existe déjà pour cette année' });
        }
        
        // Calculer toutes les statistiques en une seule requête
        const [stats] = await query(`
            SELECT 
                (SELECT COUNT(*) FROM ateliers WHERE statut = 'valide') as nb_ateliers,
                (SELECT COUNT(DISTINCT eleve_id) FROM inscriptions WHERE statut = 'confirmee') as nb_eleves,
                (SELECT COUNT(DISTINCT enseignant_acronyme) FROM ateliers WHERE statut = 'valide') as nb_enseignants,
                (SELECT COUNT(*) FROM inscriptions WHERE statut = 'confirmee') as nb_inscriptions,
                (SELECT AVG(note) FROM evaluations) as note_moyenne
        `);
        
        // Créer l'archive
        const archiveResult = await query(`
            INSERT INTO archives (annee, nom, date_cloture, stats_nb_ateliers, stats_nb_eleves, 
                stats_nb_enseignants, stats_nb_inscriptions, stats_note_moyenne, commentaire)
            VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?)
        `, [
            annee, nom, 
            stats.nb_ateliers, stats.nb_eleves, stats.nb_enseignants, 
            stats.nb_inscriptions, stats.note_moyenne || null, commentaire || null
        ]);
        
        const archiveId = archiveResult.insertId;
        
        // Charger tous les enseignants en une seule requête
        const enseignantsMap = {};
        const enseignants = await query(`SELECT acronyme, CONCAT(prenom, ' ', nom) as nom_complet FROM utilisateurs WHERE role = 'enseignant'`);
        enseignants.forEach(e => { enseignantsMap[e.acronyme] = e.nom_complet; });
        
        // Charger tous les créneaux par atelier en une seule requête
        const creneauxParAtelier = {};
        const allCreneaux = await query(`
            SELECT p.atelier_id, c.jour, c.periode, s.nom as salle_nom
            FROM planning p
            JOIN creneaux c ON p.creneau_id = c.id
            LEFT JOIN salles s ON p.salle_id = s.id
            ORDER BY p.atelier_id, c.ordre
        `);
        allCreneaux.forEach(c => {
            if (!creneauxParAtelier[c.atelier_id]) creneauxParAtelier[c.atelier_id] = [];
            creneauxParAtelier[c.atelier_id].push(c);
        });
        
        // Archiver les ateliers validés (requête unique)
        const ateliers = await query(`
            SELECT a.*, t.nom as theme_nom, t.couleur as theme_couleur,
                (SELECT COUNT(*) FROM inscriptions i WHERE i.atelier_id = a.id AND i.statut = 'confirmee') as nb_inscrits,
                (SELECT AVG(note) FROM evaluations e WHERE e.atelier_id = a.id) as note_moy,
                (SELECT COUNT(*) FROM evaluations e WHERE e.atelier_id = a.id) as nb_eval
            FROM ateliers a
            LEFT JOIN themes t ON a.theme_id = t.id
            WHERE a.statut = 'valide'
        `);
        
        // Insertion batch des ateliers archivés
        for (const atelier of ateliers) {
            const noms = [];
            if (atelier.enseignant_acronyme && enseignantsMap[atelier.enseignant_acronyme]) noms.push(enseignantsMap[atelier.enseignant_acronyme]);
            if (atelier.enseignant2_acronyme && enseignantsMap[atelier.enseignant2_acronyme]) noms.push(enseignantsMap[atelier.enseignant2_acronyme]);
            if (atelier.enseignant3_acronyme && enseignantsMap[atelier.enseignant3_acronyme]) noms.push(enseignantsMap[atelier.enseignant3_acronyme]);
            
            const creneaux = creneauxParAtelier[atelier.id] || [];
            const creneauxTexte = creneaux.map(c => `${c.jour} ${c.periode}`).join(', ');
            const salleNom = creneaux.length > 0 ? creneaux[0].salle_nom : null;
            
            await query(`
                INSERT INTO archives_ateliers (archive_id, atelier_original_id, nom, description,
                    enseignant_noms, theme_nom, theme_couleur, duree, nombre_places_max,
                    nombre_inscrits, note_moyenne, nb_evaluations, creneaux_texte, salle_nom)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                archiveId, atelier.id, atelier.nom, atelier.description,
                noms.join(', '), atelier.theme_nom, atelier.theme_couleur,
                atelier.duree, atelier.nombre_places_max, atelier.nb_inscrits,
                atelier.note_moy, atelier.nb_eval, creneauxTexte, salleNom
            ]);
        }
        
        // Archiver les inscriptions avec créneaux (requête unique avec JOIN)
        const inscriptions = await query(`
            SELECT 
                u.id as user_id, u.nom as eleve_nom, u.prenom as eleve_prenom,
                cl.nom as classe_nom, a.nom as atelier_nom, a.id as atelier_id,
                ev.note as note_donnee, ev.commentaire as commentaire_donne
            FROM inscriptions i
            JOIN eleves e ON i.eleve_id = e.id
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes cl ON e.classe_id = cl.id
            JOIN ateliers a ON i.atelier_id = a.id
            LEFT JOIN evaluations ev ON ev.eleve_id = i.eleve_id AND ev.atelier_id = i.atelier_id
            WHERE i.statut = 'confirmee'
        `);
        
        // Insertion batch des inscriptions archivées
        for (const insc of inscriptions) {
            const creneaux = creneauxParAtelier[insc.atelier_id] || [];
            const creneauxTexte = creneaux.map(c => `${c.jour} ${c.periode}`).join(', ');
            const salleNom = creneaux.length > 0 ? creneaux[0].salle_nom : null;
            
            await query(`
                INSERT INTO archives_inscriptions (archive_id, eleve_utilisateur_id, eleve_nom, eleve_prenom,
                    classe_nom, atelier_nom, creneaux_texte, salle_nom, note_donnee, commentaire_donne)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                archiveId, insc.user_id, insc.eleve_nom, insc.eleve_prenom,
                insc.classe_nom, insc.atelier_nom, creneauxTexte, salleNom,
                insc.note_donnee, insc.commentaire_donne
            ]);
        }
        
        // Reset pour nouvelle année si demandé
        if (nouvelleAnnee) {
            // Supprimer les inscriptions
            await query("DELETE FROM inscriptions");
            
            // Supprimer les évaluations
            await query("DELETE FROM evaluations");
            
            // Supprimer le planning
            await query("DELETE FROM planning");
            
            // Remettre tous les ateliers en brouillon
            await query("UPDATE ateliers SET statut = 'brouillon'");
            
            // Fermer les inscriptions des classes
            await query("UPDATE classes SET inscriptions_ouvertes = FALSE");
            
            // Mettre à jour l'année courante
            await query("UPDATE configuration SET valeur = ? WHERE cle = 'annee_courante'", [nouvelleAnnee]);
            
            // Fermer les évaluations
            await query("UPDATE configuration SET valeur = 'false' WHERE cle = 'evaluations_ouvertes'");
        }
        
        res.json({ 
            success: true, 
            message: `Archive "${nom}" créée avec succès`,
            data: { archiveId }
        });
        
    } catch (error) {
        console.error('Erreur clôture:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur: ' + error.message });
    }
});

/**
 * DELETE /api/archives/:id
 * Supprimer une archive
 */
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await query('DELETE FROM archives WHERE id = ?', [id]);
        res.json({ success: true, message: 'Archive supprimée' });
    } catch (error) {
        console.error('Erreur suppression archive:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

module.exports = router;
