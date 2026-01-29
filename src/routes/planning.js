const express = require('express');
const router = express.Router();
const { query, transaction } = require('../config/database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// Protection: toutes les routes nécessitent authentification admin
router.use(authMiddleware, adminMiddleware);

/**
 * GET /api/planning/creneaux
 * Liste de tous les créneaux
 */
router.get('/creneaux', async (req, res) => {
    try {
        const creneaux = await query('SELECT * FROM creneaux ORDER BY ordre');
        res.json({ success: true, data: creneaux });
    } catch (error) {
        console.error('Erreur liste créneaux:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/planning/allouer
 * Lance l'algorithme d'allocation automatique
 */
router.post('/allouer', async (req, res) => {
    try {
        console.log('🔄 Début de l\'allocation automatique...');
        
        // 1. Récupérer tous les ateliers validés non encore placés
        const ateliers = await query(`
            SELECT a.*, u.nom as enseignant_nom, u.prenom as enseignant_prenom
            FROM ateliers a
            LEFT JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            LEFT JOIN planning p ON a.id = p.atelier_id
            WHERE a.statut = 'valide' AND p.id IS NULL
            ORDER BY a.duree DESC, a.nombre_places_max DESC
        `);
        
        if (ateliers.length === 0) {
            return res.json({
                success: true,
                message: 'Aucun atelier à placer',
                data: { placed: 0, failed: 0 }
            });
        }
        
        // 2. Récupérer tous les créneaux
        const creneaux = await query('SELECT * FROM creneaux ORDER BY ordre');
        
        // 3. Récupérer toutes les salles disponibles
        const salles = await query('SELECT * FROM salles WHERE disponible = TRUE ORDER BY capacite DESC');
        
        // 4. Récupérer les disponibilités des enseignants
        const disponibilites = await query('SELECT * FROM disponibilites_enseignants WHERE disponible = TRUE');
        
        // Créer un map des disponibilités par enseignant
        const dispoMap = {};
        disponibilites.forEach(d => {
            if (!dispoMap[d.enseignant_acronyme]) {
                dispoMap[d.enseignant_acronyme] = new Set();
            }
            dispoMap[d.enseignant_acronyme].add(d.creneau_id);
        });
        
        // 5. Initialiser les structures de suivi
        const creneauxOccupes = {}; // { creneau_id: { salle_id: atelier_id } }
        const enseignantsOccupes = {}; // { creneau_id: { enseignant_acronyme: atelier_id } }
        
        creneaux.forEach(c => {
            creneauxOccupes[c.id] = {};
            enseignantsOccupes[c.id] = {};
        });
        
        // 6. Charger les placements déjà existants
        const placementsExistants = await query(`
            SELECT p.*, a.enseignant_acronyme
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
        `);
        
        placementsExistants.forEach(p => {
            // Marquer les créneaux occupés
            for (let i = 0; i < p.nombre_creneaux; i++) {
                const creneauId = p.creneau_id + i;
                if (creneauxOccupes[creneauId]) {
                    creneauxOccupes[creneauId][p.salle_id] = p.atelier_id;
                    enseignantsOccupes[creneauId][p.enseignant_acronyme] = p.atelier_id;
                }
            }
        });
        
        // 7. Algorithme d'allocation
        const resultat = { placed: 0, failed: [], conflicts: [] };
        
        for (const atelier of ateliers) {
            const nombreCreneaux = Math.ceil(atelier.duree / 2); // 2 périodes = 1 créneau
            let placed = false;
            
            // Essayer chaque créneau possible
            for (let i = 0; i <= creneaux.length - nombreCreneaux; i++) {
                const creneauDebut = creneaux[i];
                
                // Vérifier que l'enseignant est disponible sur tous les créneaux nécessaires
                let enseignantDisponible = true;
                const creneauxNecessaires = [];
                
                for (let j = 0; j < nombreCreneaux; j++) {
                    const creneau = creneaux[i + j];
                    creneauxNecessaires.push(creneau);
                    
                    // Vérifier disponibilité enseignant
                    if (!dispoMap[atelier.enseignant_acronyme] || 
                        !dispoMap[atelier.enseignant_acronyme].has(creneau.id)) {
                        enseignantDisponible = false;
                        break;
                    }
                    
                    // Vérifier que l'enseignant n'est pas déjà occupé
                    if (enseignantsOccupes[creneau.id][atelier.enseignant_acronyme]) {
                        enseignantDisponible = false;
                        break;
                    }
                }
                
                if (!enseignantDisponible) continue;
                
                // Vérifier la cohérence des jours pour ateliers de plusieurs créneaux
                if (nombreCreneaux > 1) {
                    const jours = creneauxNecessaires.map(c => c.jour);
                    const joursUniques = [...new Set(jours)];
                    
                    if (joursUniques.length > 1) {
                        const containsMercrediPM = creneauxNecessaires.some(c => 
                            c.jour === 'mercredi' && c.periode === 'P6-7'
                        );
                        if (containsMercrediPM) continue;
                    }
                }
                
                // Chercher une salle appropriée
                let salleChoisie = null;
                
                for (const salle of salles) {
                    if (salle.capacite < atelier.nombre_places_max) continue;
                    if (atelier.type_salle_demande && salle.type_salle !== atelier.type_salle_demande) continue;
                    
                    let salleLibre = true;
                    for (const creneau of creneauxNecessaires) {
                        if (creneauxOccupes[creneau.id][salle.id]) {
                            salleLibre = false;
                            break;
                        }
                    }
                    
                    if (salleLibre) {
                        salleChoisie = salle;
                        break;
                    }
                }
                
                // Si on a trouvé une salle, placer l'atelier
                if (salleChoisie) {
                    try {
                        await query(`
                            INSERT INTO planning (atelier_id, salle_id, creneau_id, nombre_creneaux, valide)
                            VALUES (?, ?, ?, ?, TRUE)
                        `, [atelier.id, salleChoisie.id, creneauDebut.id, nombreCreneaux]);
                        
                        // Marquer les créneaux comme occupés
                        for (const creneau of creneauxNecessaires) {
                            creneauxOccupes[creneau.id][salleChoisie.id] = atelier.id;
                            enseignantsOccupes[creneau.id][atelier.enseignant_acronyme] = atelier.id;
                        }
                        
                        resultat.placed++;
                        placed = true;
                        
                        console.log(`✅ Atelier "${atelier.nom}" placé: ${creneauDebut.jour} ${creneauDebut.periode}, salle ${salleChoisie.nom}`);
                        break;
                    } catch (error) {
                        console.error(`Erreur placement atelier ${atelier.id}:`, error);
                    }
                }
            }
            
            if (!placed) {
                resultat.failed.push({
                    id: atelier.id,
                    nom: atelier.nom,
                    enseignant: `${atelier.enseignant_prenom} ${atelier.enseignant_nom}`,
                    raison: 'Aucun créneau disponible avec salle appropriée'
                });
                console.log(`❌ Atelier "${atelier.nom}" non placé`);
            }
        }
        
        // Log de l'action
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'AUTO_ALLOCATION', `${resultat.placed} ateliers placés, ${resultat.failed.length} échecs`]
        );
        
        res.json({
            success: true,
            message: `Allocation terminée: ${resultat.placed} ateliers placés sur ${ateliers.length}`,
            data: resultat
        });
        
    } catch (error) {
        console.error('Erreur allocation:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de l\'allocation automatique',
            error: error.message
        });
    }
});

/**
 * POST /api/planning/placer-manuel
 * Placer manuellement un atelier
 */
router.post('/placer-manuel', async (req, res) => {
    try {
        const { atelier_id, salle_id, creneau_id } = req.body;
        
        if (!atelier_id || !salle_id || !creneau_id) {
            return res.status(400).json({
                success: false,
                message: 'Atelier, salle et créneau requis'
            });
        }
        
        // Vérifier que l'atelier existe et est validé
        const ateliers = await query(
            'SELECT * FROM ateliers WHERE id = ? AND statut = "valide"',
            [atelier_id]
        );
        
        if (ateliers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Atelier non trouvé ou non validé'
            });
        }
        
        const atelier = ateliers[0];
        const nombreCreneaux = Math.ceil(atelier.duree / 2);
        
        // Vérifier que la salle existe
        const salles = await query('SELECT * FROM salles WHERE id = ?', [salle_id]);
        if (salles.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Salle non trouvée'
            });
        }
        
        // Vérifier que le créneau existe
        const creneaux = await query('SELECT * FROM creneaux WHERE id = ?', [creneau_id]);
        if (creneaux.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Créneau non trouvé'
            });
        }
        
        // Vérifier que l'atelier n'est pas déjà placé
        const existant = await query('SELECT id FROM planning WHERE atelier_id = ?', [atelier_id]);
        if (existant.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Cet atelier est déjà placé dans le planning'
            });
        }
        
        // Vérifier que la salle est libre sur les créneaux nécessaires
        const creneauxToCheck = [];
        for (let i = 0; i < nombreCreneaux; i++) {
            creneauxToCheck.push(creneau_id + i);
        }
        
        const conflitSalle = await query(`
            SELECT p.*, a.nom as atelier_nom, c.jour, c.periode
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            WHERE p.salle_id = ? AND p.creneau_id IN (?)
        `, [salle_id, creneauxToCheck]);
        
        if (conflitSalle.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Conflit: salle occupée par "${conflitSalle[0].atelier_nom}" sur ce créneau`
            });
        }
        
        // Vérifier que l'enseignant n'est pas déjà occupé
        const conflitEnseignant = await query(`
            SELECT p.*, a.nom as atelier_nom, c.jour, c.periode
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_id = c.id
            WHERE a.enseignant_acronyme = ? AND p.creneau_id IN (?)
        `, [atelier.enseignant_acronyme, creneauxToCheck]);
        
        if (conflitEnseignant.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Conflit: enseignant ${atelier.enseignant_acronyme} déjà sur "${conflitEnseignant[0].atelier_nom}"`
            });
        }
        
        // Insérer le placement
        await query(`
            INSERT INTO planning (atelier_id, salle_id, creneau_id, nombre_creneaux, valide)
            VALUES (?, ?, ?, ?, TRUE)
        `, [atelier_id, salle_id, creneau_id, nombreCreneaux]);
        
        // Log
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'PLACEMENT_MANUEL', `Atelier "${atelier.nom}" placé manuellement`]
        );
        
        res.json({
            success: true,
            message: `Atelier "${atelier.nom}" placé avec succès`
        });
        
    } catch (error) {
        console.error('Erreur placement manuel:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors du placement'
        });
    }
});

/**
 * GET /api/planning/view
 * Récupération du planning complet
 */
router.get('/view', async (req, res) => {
    try {
        const planning = await query(`
            SELECT 
                p.*,
                a.nom as atelier_nom,
                a.description as atelier_description,
                a.enseignant_acronyme,
                a.nombre_places_max,
                a.duree,
                a.theme_id,
                t.nom as theme_nom,
                t.couleur as theme_couleur,
                u.nom as enseignant_nom,
                u.prenom as enseignant_prenom,
                s.nom as salle_nom,
                s.type_salle,
                s.capacite as salle_capacite,
                c.jour,
                c.periode,
                c.heure_debut,
                c.heure_fin,
                c.ordre,
                (SELECT COUNT(*) FROM inscriptions WHERE planning_id = p.id AND statut = 'confirmee') as nombre_inscrits
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            LEFT JOIN themes t ON a.theme_id = t.id
            JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            JOIN salles s ON p.salle_id = s.id
            JOIN creneaux c ON p.creneau_id = c.id
            ORDER BY c.ordre, s.nom
        `);
        
        res.json({
            success: true,
            data: planning
        });
        
    } catch (error) {
        console.error('Erreur récupération planning:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération du planning'
        });
    }
});

/**
 * GET /api/planning/grid
 * Planning sous forme de grille (jour x créneau x salle)
 */
router.get('/grid', async (req, res) => {
    try {
        const planning = await query(`
            SELECT 
                p.id as planning_id,
                p.creneau_id,
                p.nombre_creneaux,
                a.id as atelier_id,
                a.nom as atelier_nom,
                a.enseignant_acronyme,
                a.enseignant2_acronyme,
                a.enseignant3_acronyme,
                a.nombre_places_max,
                a.duree,
                a.theme_id,
                t.nom as theme_nom,
                t.couleur as theme_couleur,
                u.nom as enseignant_nom,
                u.prenom as enseignant_prenom,
                CONCAT_WS(', ', 
                    (SELECT CONCAT(prenom, ' ', nom) FROM utilisateurs WHERE acronyme = a.enseignant_acronyme),
                    (SELECT CONCAT(prenom, ' ', nom) FROM utilisateurs WHERE acronyme = a.enseignant2_acronyme),
                    (SELECT CONCAT(prenom, ' ', nom) FROM utilisateurs WHERE acronyme = a.enseignant3_acronyme)
                ) as enseignants,
                s.nom as salle_nom,
                c.jour,
                c.periode,
                c.ordre,
                (SELECT COUNT(*) FROM inscriptions WHERE planning_id = p.id AND statut = 'confirmee') as nombre_inscrits
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            LEFT JOIN themes t ON a.theme_id = t.id
            JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            JOIN salles s ON p.salle_id = s.id
            JOIN creneaux c ON p.creneau_id = c.id
        `);
        
        // Organiser en grille
        const grid = {};
        
        planning.forEach(p => {
            if (!grid[p.jour]) grid[p.jour] = {};
            if (!grid[p.jour][p.periode]) grid[p.jour][p.periode] = {};
            
            grid[p.jour][p.periode][p.salle_nom] = {
                planning_id: p.planning_id,
                atelier_id: p.atelier_id,
                atelier_nom: p.atelier_nom,
                enseignant: `${p.enseignant_prenom} ${p.enseignant_nom}`,
                enseignant_acronyme: p.enseignant_acronyme,
                enseignants: p.enseignants,
                nombre_inscrits: p.nombre_inscrits,
                nombre_places_max: p.nombre_places_max,
                nombre_creneaux: p.nombre_creneaux,
                duree: p.duree,
                theme_nom: p.theme_nom,
                theme_couleur: p.theme_couleur
            };
            
            // Marquer les créneaux de suite pour ateliers > 2p
            if (p.nombre_creneaux > 1) {
                // Créneaux de suite
                const creneauxAll = ['lundi-P1-2', 'lundi-P3-4', 'lundi-P6-7', 'mardi-P1-2', 'mardi-P3-4', 'mardi-P6-7', 'mercredi-P1-2', 'mercredi-P3-4', 'jeudi-P1-2', 'jeudi-P3-4', 'jeudi-P6-7', 'vendredi-P1-2', 'vendredi-P3-4', 'vendredi-P6-7'];
                const currentKey = `${p.jour}-${p.periode}`;
                const currentIndex = creneauxAll.indexOf(currentKey);
                
                for (let i = 1; i < p.nombre_creneaux; i++) {
                    if (currentIndex + i < creneauxAll.length) {
                        const nextKey = creneauxAll[currentIndex + i];
                        const [nextJour, nextPeriode] = nextKey.split('-').slice(0, 2).concat([nextKey.split('-').slice(2).join('-')]);
                        const [nj, np] = [nextKey.split('-')[0], nextKey.split('-').slice(1).join('-')];
                        
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
        
        res.json({
            success: true,
            data: grid
        });
        
    } catch (error) {
        console.error('Erreur grille planning:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération de la grille'
        });
    }
});

/**
 * PUT /api/planning/:id
 * Modification manuelle d'un placement
 */
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { salle_id, creneau_id } = req.body;
        
        const placements = await query('SELECT * FROM planning WHERE id = ?', [id]);
        if (placements.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Placement non trouvé'
            });
        }
        
        const placement = placements[0];
        
        await query(
            'UPDATE planning SET salle_id = ?, creneau_id = ? WHERE id = ?',
            [salle_id || placement.salle_id, creneau_id || placement.creneau_id, id]
        );
        
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'UPDATE', 'planning', id, 'Modification manuelle du planning']
        );
        
        res.json({
            success: true,
            message: 'Planning mis à jour'
        });
        
    } catch (error) {
        console.error('Erreur modification planning:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la modification'
        });
    }
});

/**
 * DELETE /api/planning/:id
 * Suppression d'un placement
 */
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        await query('DELETE FROM planning WHERE id = ?', [id]);
        
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'DELETE', 'planning', id, 'Suppression d\'un placement']
        );
        
        res.json({
            success: true,
            message: 'Placement supprimé'
        });
        
    } catch (error) {
        console.error('Erreur suppression placement:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la suppression'
        });
    }
});

/**
 * DELETE /api/planning/reset/all
 * Réinitialiser tout le planning
 */
router.delete('/reset/all', async (req, res) => {
    try {
        await query('DELETE FROM planning');
        
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'RESET_PLANNING', 'Réinitialisation complète du planning']
        );
        
        res.json({
            success: true,
            message: 'Planning réinitialisé'
        });
        
    } catch (error) {
        console.error('Erreur reset planning:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la réinitialisation'
        });
    }
});

/**
 * GET /api/planning/stats
 * Statistiques du planning
 */
router.get('/stats', async (req, res) => {
    try {
        const stats = {};
        
        const ateliersValides = await query(`
            SELECT COUNT(*) as total FROM ateliers WHERE statut = 'valide'
        `);
        
        const ateliersPlaces = await query(`
            SELECT COUNT(DISTINCT atelier_id) as total FROM planning
        `);
        
        const sallesUtilisees = await query(`
            SELECT COUNT(DISTINCT salle_id) as total FROM planning
        `);
        
        const creneauxUtilises = await query(`
            SELECT COUNT(DISTINCT creneau_id) as total FROM planning
        `);
        
        stats.ateliers_valides = ateliersValides[0].total;
        stats.ateliers_places = ateliersPlaces[0].total;
        stats.ateliers_non_places = stats.ateliers_valides - stats.ateliers_places;
        stats.salles_utilisees = sallesUtilisees[0].total;
        stats.creneaux_utilises = creneauxUtilises[0].total;
        
        res.json({
            success: true,
            data: stats
        });
        
    } catch (error) {
        console.error('Erreur stats planning:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération des statistiques'
        });
    }
});

module.exports = router;
