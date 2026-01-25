const express = require('express');
const router = express.Router();
const { query, transaction } = require('../config/database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// Toutes les routes nécessitent authentification
router.use(authMiddleware);

/**
 * GET /api/presence/mes-ateliers
 * Liste des ateliers de l'enseignant connecté (pour pointage)
 */
router.get('/mes-ateliers', async (req, res) => {
    try {
        const acronyme = req.user.acronyme;
        
        const ateliers = await query(`
            SELECT DISTINCT
                a.id as atelier_id,
                a.nom as atelier_nom,
                a.enseignant_acronyme,
                a.enseignant2_acronyme,
                a.enseignant3_acronyme,
                pl.id as planning_id,
                cr.id as creneau_id,
                cr.jour,
                cr.periode,
                cr.ordre,
                s.nom as salle_nom,
                (SELECT COUNT(*) FROM inscriptions WHERE atelier_id = a.id) as total_inscrits,
                (SELECT COUNT(*) FROM presences WHERE atelier_id = a.id AND creneau_id = cr.id AND statut = 'present') as presents,
                (SELECT COUNT(*) FROM presences WHERE atelier_id = a.id AND creneau_id = cr.id AND statut = 'absent') as absents,
                (SELECT MAX(valide_le) FROM presences WHERE atelier_id = a.id AND creneau_id = cr.id) as valide_le,
                (SELECT MAX(valide_par) FROM presences WHERE atelier_id = a.id AND creneau_id = cr.id AND valide_le IS NOT NULL) as valide_par
            FROM ateliers a
            JOIN planning pl ON a.id = pl.atelier_id
            JOIN creneaux cr ON pl.creneau_id = cr.id
            JOIN salles s ON pl.salle_id = s.id
            WHERE a.statut = 'valide'
            AND (a.enseignant_acronyme = ? 
                 OR a.enseignant2_acronyme = ? 
                 OR a.enseignant3_acronyme = ?)
            ORDER BY cr.ordre
        `, [acronyme, acronyme, acronyme]);
        
        res.json({ success: true, data: ateliers });
    } catch (error) {
        console.error('Erreur liste ateliers enseignant:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/presence/atelier/:atelierId/:creneauId
 * Liste des élèves d'un atelier pour un créneau (avec statut présence)
 */
router.get('/atelier/:atelierId/:creneauId', async (req, res) => {
    try {
        const { atelierId, creneauId } = req.params;
        const user = req.user;
        
        // Vérifier accès (admin ou enseignant de l'atelier)
        if (user.role !== 'admin') {
            const atelier = await query(`
                SELECT enseignant_acronyme, enseignant2_acronyme, enseignant3_acronyme 
                FROM ateliers WHERE id = ?
            `, [atelierId]);
            
            if (atelier.length === 0) {
                return res.status(404).json({ success: false, message: 'Atelier non trouvé' });
            }
            
            const a = atelier[0];
            if (a.enseignant_acronyme !== user.acronyme && 
                a.enseignant2_acronyme !== user.acronyme && 
                a.enseignant3_acronyme !== user.acronyme) {
                return res.status(403).json({ success: false, message: 'Accès non autorisé' });
            }
        }
        
        // Infos atelier
        const atelierInfo = await query(`
            SELECT 
                a.id, a.nom, a.enseignant_acronyme, a.enseignant2_acronyme, a.enseignant3_acronyme,
                cr.jour, cr.periode,
                s.nom as salle_nom,
                CONCAT_WS(', ', 
                    (SELECT CONCAT(prenom, ' ', nom) FROM utilisateurs WHERE acronyme = a.enseignant_acronyme),
                    (SELECT CONCAT(prenom, ' ', nom) FROM utilisateurs WHERE acronyme = a.enseignant2_acronyme),
                    (SELECT CONCAT(prenom, ' ', nom) FROM utilisateurs WHERE acronyme = a.enseignant3_acronyme)
                ) as enseignants_noms
            FROM ateliers a
            JOIN planning pl ON a.id = pl.atelier_id AND pl.creneau_id = ?
            JOIN creneaux cr ON pl.creneau_id = cr.id
            JOIN salles s ON pl.salle_id = s.id
            WHERE a.id = ?
        `, [creneauId, atelierId]);
        
        // Liste élèves avec présence
        const eleves = await query(`
            SELECT 
                e.id as eleve_id,
                u.nom,
                u.prenom,
                c.nom as classe,
                COALESCE(p.statut, 'non_pointe') as statut,
                p.commentaire,
                p.valide_le,
                p.valide_par
            FROM inscriptions i
            JOIN eleves e ON i.eleve_id = e.id
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes c ON e.classe_id = c.id
            LEFT JOIN presences p ON p.atelier_id = i.atelier_id 
                AND p.eleve_id = e.id 
                AND p.creneau_id = ?
            WHERE i.atelier_id = ?
            ORDER BY c.nom, u.nom, u.prenom
        `, [creneauId, atelierId]);
        
        // Statut validation
        const validation = await query(`
            SELECT MAX(valide_le) as valide_le, MAX(valide_par) as valide_par
            FROM presences 
            WHERE atelier_id = ? AND creneau_id = ? AND valide_le IS NOT NULL
        `, [atelierId, creneauId]);
        
        res.json({ 
            success: true, 
            data: {
                atelier: atelierInfo[0] || null,
                eleves: eleves,
                validation: validation[0] || null,
                total: eleves.length,
                presents: eleves.filter(e => e.statut === 'present').length,
                absents: eleves.filter(e => e.statut === 'absent').length
            }
        });
    } catch (error) {
        console.error('Erreur liste présence atelier:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/presence/atelier/:atelierId/:creneauId/pointer
 * Enregistrer les présences (sans valider)
 */
router.post('/atelier/:atelierId/:creneauId/pointer', async (req, res) => {
    try {
        const { atelierId, creneauId } = req.params;
        const { presences } = req.body; // Array de { eleve_id, statut, commentaire }
        const user = req.user;
        
        // Vérifier accès
        if (user.role !== 'admin') {
            const atelier = await query(`
                SELECT enseignant_acronyme, enseignant2_acronyme, enseignant3_acronyme 
                FROM ateliers WHERE id = ?
            `, [atelierId]);
            
            if (atelier.length === 0) {
                return res.status(404).json({ success: false, message: 'Atelier non trouvé' });
            }
            
            const a = atelier[0];
            if (a.enseignant_acronyme !== user.acronyme && 
                a.enseignant2_acronyme !== user.acronyme && 
                a.enseignant3_acronyme !== user.acronyme) {
                return res.status(403).json({ success: false, message: 'Accès non autorisé' });
            }
        }
        
        // Enregistrer chaque présence
        for (const p of presences) {
            await query(`
                INSERT INTO presences (atelier_id, eleve_id, creneau_id, statut, commentaire)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                    statut = VALUES(statut),
                    commentaire = VALUES(commentaire),
                    updated_at = CURRENT_TIMESTAMP
            `, [atelierId, p.eleve_id, creneauId, p.statut, p.commentaire || null]);
        }
        
        res.json({ 
            success: true, 
            message: `${presences.length} présences enregistrées` 
        });
    } catch (error) {
        console.error('Erreur pointage:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/presence/atelier/:atelierId/:creneauId/valider
 * Valider définitivement le pointage
 */
router.post('/atelier/:atelierId/:creneauId/valider', async (req, res) => {
    try {
        const { atelierId, creneauId } = req.params;
        const { presences } = req.body;
        const user = req.user;
        
        // Vérifier accès
        if (user.role !== 'admin') {
            const atelier = await query(`
                SELECT enseignant_acronyme, enseignant2_acronyme, enseignant3_acronyme 
                FROM ateliers WHERE id = ?
            `, [atelierId]);
            
            if (atelier.length === 0) {
                return res.status(404).json({ success: false, message: 'Atelier non trouvé' });
            }
            
            const a = atelier[0];
            if (a.enseignant_acronyme !== user.acronyme && 
                a.enseignant2_acronyme !== user.acronyme && 
                a.enseignant3_acronyme !== user.acronyme) {
                return res.status(403).json({ success: false, message: 'Accès non autorisé' });
            }
        }
        
        // Enregistrer et valider chaque présence
        let presents = 0, absents = 0;
        
        for (const p of presences) {
            await query(`
                INSERT INTO presences (atelier_id, eleve_id, creneau_id, statut, commentaire, valide_par, valide_le)
                VALUES (?, ?, ?, ?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE 
                    statut = VALUES(statut),
                    commentaire = VALUES(commentaire),
                    valide_par = VALUES(valide_par),
                    valide_le = NOW(),
                    updated_at = CURRENT_TIMESTAMP
            `, [atelierId, p.eleve_id, creneauId, p.statut, p.commentaire || null, user.acronyme]);
            
            if (p.statut === 'present') presents++;
            else if (p.statut === 'absent') absents++;
        }
        
        // Historique
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [user.id, 'VALIDATE_PRESENCE', `Présences validées atelier #${atelierId} créneau #${creneauId}: ${presents}P/${absents}A`]
        );
        
        res.json({ 
            success: true, 
            message: `Présences validées : ${presents} présents, ${absents} absents`,
            data: { presents, absents }
        });
    } catch (error) {
        console.error('Erreur validation présences:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ============================================================
// ROUTES ADMIN - Absences
// ============================================================

/**
 * GET /api/presence/admin/ateliers
 * Liste tous les ateliers avec statut pointage (admin)
 */
router.get('/admin/ateliers', adminMiddleware, async (req, res) => {
    try {
        const ateliers = await query(`
            SELECT 
                a.id as atelier_id,
                a.nom as atelier_nom,
                a.enseignant_acronyme,
                a.enseignant2_acronyme,
                a.enseignant3_acronyme,
                pl.id as planning_id,
                cr.id as creneau_id,
                cr.jour,
                cr.periode,
                cr.ordre,
                s.nom as salle_nom,
                (SELECT COUNT(*) FROM inscriptions WHERE atelier_id = a.id) as total_inscrits,
                (SELECT COUNT(*) FROM presences WHERE atelier_id = a.id AND creneau_id = cr.id AND statut = 'present') as presents,
                (SELECT COUNT(*) FROM presences WHERE atelier_id = a.id AND creneau_id = cr.id AND statut = 'absent') as absents,
                (SELECT MAX(valide_le) FROM presences WHERE atelier_id = a.id AND creneau_id = cr.id) as valide_le,
                (SELECT MAX(valide_par) FROM presences WHERE atelier_id = a.id AND creneau_id = cr.id AND valide_le IS NOT NULL) as valide_par
            FROM ateliers a
            JOIN planning pl ON a.id = pl.atelier_id
            JOIN creneaux cr ON pl.creneau_id = cr.id
            JOIN salles s ON pl.salle_id = s.id
            WHERE a.statut = 'valide'
            ORDER BY cr.ordre, a.nom
        `);
        
        res.json({ success: true, data: ateliers });
    } catch (error) {
        console.error('Erreur liste ateliers admin:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/presence/admin/absences
 * Liste des absences (filtrable par créneau, jour, classe)
 */
router.get('/admin/absences', adminMiddleware, async (req, res) => {
    try {
        const { creneau_id, jour, classe } = req.query;
        
        let sql = `
            SELECT 
                p.id as presence_id,
                a.id as atelier_id,
                a.nom as atelier_nom,
                e.id as eleve_id,
                u.nom as eleve_nom,
                u.prenom as eleve_prenom,
                c.nom as classe_nom,
                cr.id as creneau_id,
                cr.jour,
                cr.periode,
                cr.ordre,
                s.nom as salle_nom,
                p.commentaire,
                p.valide_par,
                p.valide_le
            FROM presences p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN eleves e ON p.eleve_id = e.id
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes c ON e.classe_id = c.id
            JOIN creneaux cr ON p.creneau_id = cr.id
            LEFT JOIN planning pl ON a.id = pl.atelier_id AND pl.creneau_id = cr.id
            LEFT JOIN salles s ON pl.salle_id = s.id
            WHERE p.statut = 'absent'
        `;
        
        const params = [];
        
        if (creneau_id) {
            sql += ' AND cr.id = ?';
            params.push(creneau_id);
        }
        
        if (jour) {
            sql += ' AND cr.jour = ?';
            params.push(jour);
        }
        
        if (classe) {
            sql += ' AND c.nom = ?';
            params.push(classe);
        }
        
        sql += ' ORDER BY cr.ordre, c.nom, u.nom, u.prenom';
        
        const absences = await query(sql, params);
        
        // Stats
        const stats = await query(`
            SELECT 
                cr.id as creneau_id,
                cr.jour,
                cr.periode,
                COUNT(*) as total_absents
            FROM presences p
            JOIN creneaux cr ON p.creneau_id = cr.id
            WHERE p.statut = 'absent'
            GROUP BY cr.id
            ORDER BY cr.ordre
        `);
        
        res.json({ 
            success: true, 
            data: absences,
            stats: stats,
            total: absences.length
        });
    } catch (error) {
        console.error('Erreur liste absences:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/presence/admin/stats
 * Statistiques globales de présence
 */
router.get('/admin/stats', adminMiddleware, async (req, res) => {
    try {
        // Stats par créneau
        const parCreneau = await query(`
            SELECT 
                cr.id as creneau_id,
                cr.jour,
                cr.periode,
                cr.ordre,
                COUNT(DISTINCT CASE WHEN p.statut = 'present' THEN p.id END) as presents,
                COUNT(DISTINCT CASE WHEN p.statut = 'absent' THEN p.id END) as absents,
                COUNT(DISTINCT CASE WHEN p.statut = 'non_pointe' OR p.id IS NULL THEN i.id END) as non_pointes,
                COUNT(DISTINCT CASE WHEN p.valide_le IS NOT NULL THEN p.atelier_id END) as ateliers_valides,
                (SELECT COUNT(DISTINCT pl2.atelier_id) FROM planning pl2 WHERE pl2.creneau_id = cr.id) as total_ateliers
            FROM creneaux cr
            LEFT JOIN planning pl ON cr.id = pl.creneau_id
            LEFT JOIN inscriptions i ON pl.atelier_id = i.atelier_id
            LEFT JOIN presences p ON i.atelier_id = p.atelier_id AND i.eleve_id = p.eleve_id AND cr.id = p.creneau_id
            GROUP BY cr.id
            ORDER BY cr.ordre
        `);
        
        // Stats globales
        const global = await query(`
            SELECT 
                COUNT(DISTINCT CASE WHEN statut = 'present' THEN id END) as total_presents,
                COUNT(DISTINCT CASE WHEN statut = 'absent' THEN id END) as total_absents,
                COUNT(DISTINCT CASE WHEN valide_le IS NOT NULL THEN CONCAT(atelier_id, '-', creneau_id) END) as ateliers_valides
            FROM presences
        `);
        
        // Ateliers non pointés
        const nonPointes = await query(`
            SELECT 
                a.id as atelier_id,
                a.nom as atelier_nom,
                cr.jour,
                cr.periode,
                a.enseignant_acronyme
            FROM planning pl
            JOIN ateliers a ON pl.atelier_id = a.id
            JOIN creneaux cr ON pl.creneau_id = cr.id
            WHERE a.statut = 'valide'
            AND NOT EXISTS (
                SELECT 1 FROM presences p 
                WHERE p.atelier_id = a.id 
                AND p.creneau_id = cr.id 
                AND p.valide_le IS NOT NULL
            )
            ORDER BY cr.ordre
        `);
        
        res.json({ 
            success: true, 
            data: {
                parCreneau,
                global: global[0],
                nonPointes,
                totalNonPointes: nonPointes.length
            }
        });
    } catch (error) {
        console.error('Erreur stats présences:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

module.exports = router;
