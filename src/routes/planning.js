const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

router.use(authMiddleware, adminMiddleware);

/**
 * GET /api/planning/creneaux
 */
router.get('/creneaux', async (req, res) => {
    try {
        const creneaux = await query('SELECT * FROM creneaux ORDER BY ordre');
        res.json({ success: true, data: creneaux });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/planning/ateliers-non-places
 * Liste des ateliers validés non encore placés
 */
router.get('/ateliers-non-places', async (req, res) => {
    try {
        const ateliers = await query(`
            SELECT a.*, u.nom as enseignant_nom, u.prenom as enseignant_prenom
            FROM ateliers a
            LEFT JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            LEFT JOIN planning p ON a.id = p.atelier_id
            WHERE a.statut = 'valide' AND p.id IS NULL
            ORDER BY a.nom
        `);
        res.json({ success: true, data: ateliers });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/planning/allouer
 */
router.post('/allouer', async (req, res) => {
    try {
        console.log('🔄 Début de l\'allocation automatique...');
        
        const ateliers = await query(`
            SELECT a.*, u.nom as enseignant_nom, u.prenom as enseignant_prenom
            FROM ateliers a
            LEFT JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            LEFT JOIN planning p ON a.id = p.atelier_id
            WHERE a.statut = 'valide' AND p.id IS NULL
            ORDER BY a.duree DESC, a.nombre_places_max DESC
        `);
        
        if (ateliers.length === 0) {
            return res.json({ success: true, message: 'Aucun atelier à placer', data: { placed: 0, failed: 0 } });
        }
        
        const creneaux = await query('SELECT * FROM creneaux ORDER BY ordre');
        const salles = await query('SELECT * FROM salles WHERE disponible = TRUE ORDER BY capacite DESC');
        const disponibilites = await query('SELECT * FROM disponibilites_enseignants WHERE disponible = TRUE');
        
        const dispoMap = {};
        disponibilites.forEach(d => {
            if (!dispoMap[d.enseignant_acronyme]) dispoMap[d.enseignant_acronyme] = new Set();
            dispoMap[d.enseignant_acronyme].add(d.creneau_id);
        });
        
        const creneauxOccupes = {};
        const enseignantsOccupes = {};
        creneaux.forEach(c => { creneauxOccupes[c.id] = {}; enseignantsOccupes[c.id] = {}; });
        
        const placementsExistants = await query(`SELECT p.*, a.enseignant_acronyme FROM planning p JOIN ateliers a ON p.atelier_id = a.id`);
        placementsExistants.forEach(p => {
            for (let i = 0; i < p.nombre_creneaux; i++) {
                const creneauId = p.creneau_id + i;
                if (creneauxOccupes[creneauId]) {
                    creneauxOccupes[creneauId][p.salle_id] = p.atelier_id;
                    enseignantsOccupes[creneauId][p.enseignant_acronyme] = p.atelier_id;
                }
            }
        });
        
        const resultat = { placed: 0, failed: [] };
        
        for (const atelier of ateliers) {
            const nombreCreneaux = Math.ceil(atelier.duree / 2);
            let placed = false;
            
            for (let i = 0; i <= creneaux.length - nombreCreneaux; i++) {
                const creneauDebut = creneaux[i];
                let enseignantDisponible = true;
                const creneauxNecessaires = [];
                
                for (let j = 0; j < nombreCreneaux; j++) {
                    const creneau = creneaux[i + j];
                    creneauxNecessaires.push(creneau);
                    if (!dispoMap[atelier.enseignant_acronyme] || !dispoMap[atelier.enseignant_acronyme].has(creneau.id)) {
                        enseignantDisponible = false; break;
                    }
                    if (enseignantsOccupes[creneau.id][atelier.enseignant_acronyme]) {
                        enseignantDisponible = false; break;
                    }
                }
                
                if (!enseignantDisponible) continue;
                
                let salleChoisie = null;
                for (const salle of salles) {
                    if (salle.capacite < atelier.nombre_places_max) continue;
                    if (atelier.type_salle_demande && salle.type_salle !== atelier.type_salle_demande) continue;
                    
                    let salleLibre = true;
                    for (const creneau of creneauxNecessaires) {
                        if (creneauxOccupes[creneau.id][salle.id]) { salleLibre = false; break; }
                    }
                    if (salleLibre) { salleChoisie = salle; break; }
                }
                
                if (salleChoisie) {
                    try {
                        await query(`INSERT INTO planning (atelier_id, salle_id, creneau_id, nombre_creneaux, valide) VALUES (?, ?, ?, ?, TRUE)`,
                            [atelier.id, salleChoisie.id, creneauDebut.id, nombreCreneaux]);
                        for (const creneau of creneauxNecessaires) {
                            creneauxOccupes[creneau.id][salleChoisie.id] = atelier.id;
                            enseignantsOccupes[creneau.id][atelier.enseignant_acronyme] = atelier.id;
                        }
                        resultat.placed++;
                        placed = true;
                        console.log(`✅ Atelier "${atelier.nom}" placé`);
                        break;
                    } catch (error) {
                        console.error(`Erreur placement atelier ${atelier.id}:`, error);
                    }
                }
            }
            
            if (!placed) {
                resultat.failed.push({ id: atelier.id, nom: atelier.nom, raison: 'Aucun créneau disponible' });
            }
        }
        
        await query('INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'AUTO_ALLOCATION', `${resultat.placed} ateliers placés`]);
        
        res.json({ success: true, message: `${resultat.placed} ateliers placés sur ${ateliers.length}`, data: resultat });
    } catch (error) {
        console.error('Erreur allocation:', error);
        res.status(500).json({ success: false, message: 'Erreur: ' + error.message });
    }
});

/**
 * POST /api/planning/placer-manuel
 */
router.post('/placer-manuel', async (req, res) => {
    try {
        const { atelier_id, salle_id, creneau_id } = req.body;
        
        if (!atelier_id || !salle_id || !creneau_id) {
            return res.status(400).json({ success: false, message: 'Atelier, salle et créneau requis' });
        }
        
        const ateliers = await query('SELECT * FROM ateliers WHERE id = ? AND statut = "valide"', [atelier_id]);
        if (ateliers.length === 0) {
            return res.status(404).json({ success: false, message: 'Atelier non trouvé ou non validé' });
        }
        const atelier = ateliers[0];
        const nombreCreneaux = Math.ceil(atelier.duree / 2);
        
        const salles = await query('SELECT * FROM salles WHERE id = ?', [salle_id]);
        if (salles.length === 0) {
            return res.status(404).json({ success: false, message: 'Salle non trouvée' });
        }
        
        const creneaux = await query('SELECT * FROM creneaux WHERE id = ?', [creneau_id]);
        if (creneaux.length === 0) {
            return res.status(404).json({ success: false, message: 'Créneau non trouvé' });
        }
        
        const existant = await query('SELECT id FROM planning WHERE atelier_id = ?', [atelier_id]);
        if (existant.length > 0) {
            return res.status(400).json({ success: false, message: 'Cet atelier est déjà placé' });
        }
        
        // Vérifier conflits salle
        const creneauxToCheck = [];
        for (let i = 0; i < nombreCreneaux; i++) creneauxToCheck.push(creneau_id + i);
        
        const conflitSalle = await query(`
            SELECT a.nom as atelier_nom FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            WHERE p.salle_id = ? AND p.creneau_id IN (?)
        `, [salle_id, creneauxToCheck]);
        
        if (conflitSalle.length > 0) {
            return res.status(400).json({ success: false, message: `Conflit: salle occupée par "${conflitSalle[0].atelier_nom}"` });
        }
        
        // Vérifier conflits enseignant
        const conflitEnseignant = await query(`
            SELECT a.nom as atelier_nom FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            WHERE a.enseignant_acronyme = ? AND p.creneau_id IN (?)
        `, [atelier.enseignant_acronyme, creneauxToCheck]);
        
        if (conflitEnseignant.length > 0) {
            return res.status(400).json({ success: false, message: `Conflit: enseignant déjà sur "${conflitEnseignant[0].atelier_nom}"` });
        }
        
        await query(`INSERT INTO planning (atelier_id, salle_id, creneau_id, nombre_creneaux, valide) VALUES (?, ?, ?, ?, TRUE)`,
            [atelier_id, salle_id, creneau_id, nombreCreneaux]);
        
        await query('INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'PLACEMENT_MANUEL', `Atelier "${atelier.nom}" placé`]);
        
        res.json({ success: true, message: `Atelier "${atelier.nom}" placé avec succès` });
    } catch (error) {
        console.error('Erreur placement manuel:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/planning/view
 */
router.get('/view', async (req, res) => {
    try {
        const planning = await query(`
            SELECT p.*, a.nom as atelier_nom, a.description, a.enseignant_acronyme, a.nombre_places_max, a.duree,
                a.theme_id, t.nom as theme_nom, t.couleur as theme_couleur,
                u.nom as enseignant_nom, u.prenom as enseignant_prenom,
                s.nom as salle_nom, s.type_salle, s.capacite as salle_capacite,
                c.jour, c.periode, c.heure_debut, c.heure_fin, c.ordre,
                (SELECT COUNT(*) FROM inscriptions WHERE planning_id = p.id AND statut = 'confirmee') as nombre_inscrits
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            LEFT JOIN themes t ON a.theme_id = t.id
            JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            JOIN salles s ON p.salle_id = s.id
            JOIN creneaux c ON p.creneau_id = c.id
            ORDER BY c.ordre, s.nom
        `);
        res.json({ success: true, data: planning });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/planning/grid
 */
router.get('/grid', async (req, res) => {
    try {
        const planning = await query(`
            SELECT p.id as planning_id, p.creneau_id, p.nombre_creneaux,
                a.id as atelier_id, a.nom as atelier_nom, a.enseignant_acronyme,
                a.enseignant2_acronyme, a.enseignant3_acronyme,
                a.nombre_places_max, a.duree, a.theme_id,
                t.nom as theme_nom, t.couleur as theme_couleur,
                u.nom as enseignant_nom, u.prenom as enseignant_prenom,
                s.nom as salle_nom, c.jour, c.periode, c.ordre,
                (SELECT COUNT(*) FROM inscriptions WHERE planning_id = p.id AND statut = 'confirmee') as nombre_inscrits
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            LEFT JOIN themes t ON a.theme_id = t.id
            JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            JOIN salles s ON p.salle_id = s.id
            JOIN creneaux c ON p.creneau_id = c.id
        `);
        
        const grid = {};
        const allCreneaux = ['lundi-P1-2', 'lundi-P3-4', 'lundi-P6-7', 'mardi-P1-2', 'mardi-P3-4', 'mardi-P6-7', 
            'mercredi-P1-2', 'mercredi-P3-4', 'jeudi-P1-2', 'jeudi-P3-4', 'jeudi-P6-7', 
            'vendredi-P1-2', 'vendredi-P3-4', 'vendredi-P6-7'];
        
        planning.forEach(p => {
            if (!grid[p.jour]) grid[p.jour] = {};
            if (!grid[p.jour][p.periode]) grid[p.jour][p.periode] = {};
            
            grid[p.jour][p.periode][p.salle_nom] = {
                planning_id: p.planning_id,
                atelier_id: p.atelier_id,
                atelier_nom: p.atelier_nom,
                enseignant_acronyme: p.enseignant_acronyme,
                nombre_inscrits: p.nombre_inscrits,
                nombre_places_max: p.nombre_places_max,
                nombre_creneaux: p.nombre_creneaux,
                duree: p.duree,
                theme_nom: p.theme_nom,
                theme_couleur: p.theme_couleur
            };
            
            // Marquer créneaux suite
            if (p.nombre_creneaux > 1) {
                const currentKey = `${p.jour}-${p.periode}`;
                const currentIndex = allCreneaux.indexOf(currentKey);
                
                for (let i = 1; i < p.nombre_creneaux; i++) {
                    if (currentIndex + i < allCreneaux.length) {
                        const nextKey = allCreneaux[currentIndex + i];
                        const parts = nextKey.split('-');
                        const nj = parts[0];
                        const np = parts.slice(1).join('-');
                        
                        if (!grid[nj]) grid[nj] = {};
                        if (!grid[nj][np]) grid[nj][np] = {};
                        
                        grid[nj][np][p.salle_nom] = {
                            ...grid[p.jour][p.periode][p.salle_nom],
                            suite_atelier: true
                        };
                    }
                }
            }
        });
        
        res.json({ success: true, data: grid });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * PUT /api/planning/:id
 */
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { salle_id, creneau_id } = req.body;
        
        const placements = await query('SELECT * FROM planning WHERE id = ?', [id]);
        if (placements.length === 0) {
            return res.status(404).json({ success: false, message: 'Placement non trouvé' });
        }
        
        await query('UPDATE planning SET salle_id = ?, creneau_id = ? WHERE id = ?',
            [salle_id || placements[0].salle_id, creneau_id || placements[0].creneau_id, id]);
        
        res.json({ success: true, message: 'Planning mis à jour' });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * DELETE /api/planning/:id
 */
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await query('DELETE FROM planning WHERE id = ?', [id]);
        res.json({ success: true, message: 'Placement supprimé' });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * DELETE /api/planning/reset/all
 */
router.delete('/reset/all', async (req, res) => {
    try {
        await query('DELETE FROM planning');
        res.json({ success: true, message: 'Planning réinitialisé' });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/planning/stats
 */
router.get('/stats', async (req, res) => {
    try {
        const ateliersValides = await query(`SELECT COUNT(*) as total FROM ateliers WHERE statut = 'valide'`);
        const ateliersPlaces = await query(`SELECT COUNT(DISTINCT atelier_id) as total FROM planning`);
        const sallesUtilisees = await query(`SELECT COUNT(DISTINCT salle_id) as total FROM planning`);
        
        res.json({
            success: true,
            data: {
                ateliers_valides: ateliersValides[0].total,
                ateliers_places: ateliersPlaces[0].total,
                ateliers_non_places: ateliersValides[0].total - ateliersPlaces[0].total,
                salles_utilisees: sallesUtilisees[0].total
            }
        });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

module.exports = router;
