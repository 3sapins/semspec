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
        const creneaux = await query(`
            SELECT id, jour, periode, heure_debut, heure_fin, ordre
            FROM creneaux
            ORDER BY ordre
        `);
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
                const creneauId = p.creneau_debut_id + i;
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
                    // Ateliers de 4+ périodes doivent être sur créneaux consécutifs du même jour ou sur plusieurs jours
                    const jours = creneauxNecessaires.map(c => c.jour);
                    const joursUniques = [...new Set(jours)];
                    
                    // Si sur plusieurs jours, vérifier qu'on ne chevauche pas mercredi après-midi
                    if (joursUniques.length > 1) {
                        const containsMercrediPM = creneauxNecessaires.some(c => 
                            c.jour === 'mercredi' && c.periode === 'P6-7'
                        );
                        if (containsMercrediPM) continue; // Mercredi PM n'existe pas
                    }
                }
                
                // Chercher une salle appropriée
                let salleChoisie = null;
                
                for (const salle of salles) {
                    // Vérifier la capacité
                    if (salle.capacite < atelier.nombre_places_max) continue;
                    
                    // Vérifier le type de salle si spécifié
                    if (atelier.type_salle_demande && 
                        salle.type_salle !== atelier.type_salle_demande) continue;
                    
                    // Vérifier que la salle est libre sur tous les créneaux
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
                            INSERT INTO planning (atelier_id, salle_id, creneau_debut_id, nombre_creneaux, valide)
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
                COUNT(DISTINCT i.id) as nombre_inscrits
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            JOIN salles s ON p.salle_id = s.id
            JOIN creneaux c ON p.creneau_debut_id = c.id
            LEFT JOIN inscriptions i ON p.id = i.planning_id AND i.statut = 'confirmee'
            GROUP BY p.id
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
 * UTILISE LA VUE MULTI-BLOCS pour afficher les ateliers sur tous leurs créneaux
 */
router.get('/grid', async (req, res) => {
    try {
        // Utiliser la vue multi-blocs qui "déplie" les ateliers sur tous leurs créneaux
        const planning = await query(`
            SELECT 
                planning_id,
                atelier_id,
                atelier_nom,
                duree,
                enseignant_acronyme,
                enseignant2_acronyme,
                enseignant3_acronyme,
                salle_nom,
                creneau_id,
                jour,
                periode,
                ordre,
                est_creneau_debut,
                nombre_inscrits,
                nombre_places_max
            FROM vue_planning_multiblocs
            ORDER BY ordre, salle_nom
        `);
        
        // Récupérer les noms des enseignants
        const planningAvecEnseignants = await Promise.all(
            planning.map(async (p) => {
                const enseignants = [];
                
                // Enseignant 1
                const ens1 = await query(`
                    SELECT nom, prenom FROM utilisateurs WHERE acronyme = ?
                `, [p.enseignant_acronyme]);
                if (ens1.length > 0) {
                    enseignants.push(`${ens1[0].prenom} ${ens1[0].nom}`);
                }
                
                // Enseignant 2
                if (p.enseignant2_acronyme) {
                    const ens2 = await query(`
                        SELECT nom, prenom FROM utilisateurs WHERE acronyme = ?
                    `, [p.enseignant2_acronyme]);
                    if (ens2.length > 0) {
                        enseignants.push(`${ens2[0].prenom} ${ens2[0].nom}`);
                    }
                }
                
                // Enseignant 3
                if (p.enseignant3_acronyme) {
                    const ens3 = await query(`
                        SELECT nom, prenom FROM utilisateurs WHERE acronyme = ?
                    `, [p.enseignant3_acronyme]);
                    if (ens3.length > 0) {
                        enseignants.push(`${ens3[0].prenom} ${ens3[0].nom}`);
                    }
                }
                
                return {
                    ...p,
                    enseignants: enseignants.join(' + ')
                };
            })
        );
        
        // Organiser en grille
        const grid = {};
        
        planningAvecEnseignants.forEach(p => {
            if (!grid[p.jour]) grid[p.jour] = {};
            if (!grid[p.jour][p.periode]) grid[p.jour][p.periode] = {};
            
            grid[p.jour][p.periode][p.salle_nom] = {
                id: p.planning_id,
                atelier_id: p.atelier_id,
                atelier_nom: p.atelier_nom,
                duree: p.duree,
                enseignants: p.enseignants,
                enseignant_acronyme: p.enseignant_acronyme,
                enseignant2_acronyme: p.enseignant2_acronyme,
                enseignant3_acronyme: p.enseignant3_acronyme,
                nombre_inscrits: p.nombre_inscrits,
                nombre_places_max: p.nombre_places_max,
                est_creneau_debut: p.est_creneau_debut,
                // Indicateur visuel pour affichage
                suite_atelier: !p.est_creneau_debut
            };
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
        const { salle_id, creneau_debut_id } = req.body;
        
        // Vérifier que le placement existe
        const placements = await query('SELECT * FROM planning WHERE id = ?', [id]);
        if (placements.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Placement non trouvé'
            });
        }
        
        const placement = placements[0];
        const newSalleId = salle_id || placement.salle_id;
        const newCreneauId = creneau_debut_id || placement.creneau_debut_id;
        
        // Récupérer les informations de l'atelier
        const ateliers = await query('SELECT * FROM ateliers WHERE id = ?', [placement.atelier_id]);
        const atelier = ateliers[0];
        
        // Récupérer le créneau de début
        const creneaux = await query('SELECT * FROM creneaux WHERE id = ?', [newCreneauId]);
        if (creneaux.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Créneau invalide'
            });
        }
        const creneau = creneaux[0];
        
        // Vérifier conflits salle
        const conflitsSalle = await query(`
            SELECT p.id, a.nom, c.jour, c.periode
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN creneaux c ON p.creneau_debut_id = c.id
            JOIN creneaux c2 ON c2.jour = c.jour
            WHERE p.salle_id = ?
            AND p.id != ?
            AND c2.jour = ?
            AND c2.ordre >= ?
            AND c2.ordre < ?
            AND EXISTS (
                SELECT 1 FROM creneaux c3
                WHERE c3.jour = c.jour
                AND c3.ordre >= c.ordre
                AND c3.ordre < c.ordre + p.nombre_creneaux
                AND c3.id = c2.id
            )
        `, [newSalleId, id, creneau.jour, creneau.ordre, creneau.ordre + placement.nombre_creneaux]);
        
        if (conflitsSalle.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Conflit de salle : ${conflitsSalle[0].nom} est déjà dans cette salle sur ce créneau`
            });
        }
        
        // Vérifier conflits enseignant
        const enseignants = [atelier.enseignant_acronyme];
        if (atelier.enseignant2_acronyme) enseignants.push(atelier.enseignant2_acronyme);
        if (atelier.enseignant3_acronyme) enseignants.push(atelier.enseignant3_acronyme);
        
        for (const ensAcronyme of enseignants) {
            const conflitsEns = await query(`
                SELECT p.id, a.nom, c.jour, c.periode
                FROM planning p
                JOIN ateliers a ON p.atelier_id = a.id
                JOIN creneaux c ON p.creneau_debut_id = c.id
                JOIN creneaux c2 ON c2.jour = c.jour
                WHERE p.id != ?
                AND (a.enseignant_acronyme = ? OR a.enseignant2_acronyme = ? OR a.enseignant3_acronyme = ?)
                AND c2.jour = ?
                AND c2.ordre >= ?
                AND c2.ordre < ?
                AND EXISTS (
                    SELECT 1 FROM creneaux c3
                    WHERE c3.jour = c.jour
                    AND c3.ordre >= c.ordre
                    AND c3.ordre < c.ordre + p.nombre_creneaux
                    AND c3.id = c2.id
                )
            `, [id, ensAcronyme, ensAcronyme, ensAcronyme, creneau.jour, creneau.ordre, creneau.ordre + placement.nombre_creneaux]);
            
            if (conflitsEns.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: `Conflit enseignant : ${ensAcronyme} a déjà l'atelier "${conflitsEns[0].nom}" sur ce créneau`
                });
            }
        }
        
        // Mettre à jour
        await query(
            'UPDATE planning SET salle_id = ?, creneau_debut_id = ? WHERE id = ?',
            [newSalleId, newCreneauId, id]
        );
        
        // Log
        await query(
            'INSERT INTO historique (utilisateur_id, action, table_cible, id_cible, details) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, 'UPDATE', 'planning', id, 'Modification manuelle du planning']
        );
        
        res.json({
            success: true,
            message: 'Planning mis à jour avec succès'
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
        
        // Log
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
 * DELETE /api/planning/reset
 * Réinitialiser tout le planning
 */
router.delete('/reset', async (req, res) => {
    try {
        await query('DELETE FROM planning');
        
        // Log
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
        // Ateliers placés vs non placés
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
            SELECT COUNT(DISTINCT creneau_debut_id) as total FROM planning
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

/**
 * GET /api/planning/vue-salles
 * Planning : Jours/Périodes (colonnes) × Salles (lignes)
 */
router.get('/vue-salles', async (req, res) => {
    try {
        const planning = await query(`
            SELECT 
                p.*,
                a.nom as atelier_nom,
                a.duree,
                a.nombre_places_max,
                a.enseignant_acronyme,
                s.nom as salle_nom,
                s.id as salle_id,
                c.jour,
                c.periode,
                c.ordre,
                COUNT(DISTINCT i.id) as nombre_inscrits
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN salles s ON p.salle_id = s.id
            JOIN creneaux c ON p.creneau_debut_id = c.id
            LEFT JOIN inscriptions i ON p.id = i.planning_id AND i.statut = 'confirmee'
            GROUP BY p.id
            ORDER BY s.nom, c.ordre
        `);
        
        // Organiser en grille: salles × (jour-periode)
        const salles = {};
        
        planning.forEach(p => {
            if (!salles[p.salle_nom]) {
                salles[p.salle_nom] = { salle_id: p.salle_id, creneaux: {} };
            }
            
            const key = `${p.jour}_${p.periode}`;
            salles[p.salle_nom].creneaux[key] = {
                atelier_nom: p.atelier_nom,
                enseignant: p.enseignant_acronyme,
                inscrits: p.nombre_inscrits,
                places_max: p.nombre_places_max,
                duree: p.duree
            };
        });
        
        res.json({ success: true, data: salles });
    } catch (error) {
        console.error('Erreur vue salles:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/planning/vue-enseignants
 * Planning : Jours/Périodes (colonnes) × Enseignants (lignes)
 */
router.get('/vue-enseignants', async (req, res) => {
    try {
        const planning = await query(`
            SELECT 
                p.*,
                a.nom as atelier_nom,
                a.enseignant_acronyme,
                a.duree,
                u.nom as enseignant_nom,
                u.prenom as enseignant_prenom,
                s.nom as salle_nom,
                c.jour,
                c.periode,
                c.ordre,
                COUNT(DISTINCT i.id) as nombre_inscrits
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            JOIN salles s ON p.salle_id = s.id
            JOIN creneaux c ON p.creneau_debut_id = c.id
            LEFT JOIN inscriptions i ON p.id = i.planning_id AND i.statut = 'confirmee'
            GROUP BY p.id
            ORDER BY u.nom, u.prenom, c.ordre
        `);
        
        // Organiser en grille: enseignants × (jour-periode)
        const enseignants = {};
        
        planning.forEach(p => {
            const ensKey = p.enseignant_acronyme;
            if (!enseignants[ensKey]) {
                enseignants[ensKey] = {
                    nom: p.enseignant_nom,
                    prenom: p.enseignant_prenom,
                    creneaux: {}
                };
            }
            
            const key = `${p.jour}_${p.periode}`;
            enseignants[ensKey].creneaux[key] = {
                atelier_nom: p.atelier_nom,
                salle: p.salle_nom,
                inscrits: p.nombre_inscrits,
                duree: p.duree
            };
        });
        
        res.json({ success: true, data: enseignants });
    } catch (error) {
        console.error('Erreur vue enseignants:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/planning/occupation-creneaux
 * Calcul du nombre d'élèves occupés par créneau
 */
router.get('/occupation-creneaux', async (req, res) => {
    try {
        const occupation = await query(`
            SELECT 
                c.id as creneau_id,
                c.jour,
                c.periode,
                c.ordre,
                COUNT(DISTINCT i.eleve_id) as eleves_inscrits,
                SUM(a.nombre_places_max) as places_max_total
            FROM creneaux c
            LEFT JOIN planning p ON c.id = p.creneau_debut_id
            LEFT JOIN ateliers a ON p.atelier_id = a.id
            LEFT JOIN inscriptions i ON p.id = i.planning_id AND i.statut = 'confirmee'
            GROUP BY c.id
            ORDER BY c.ordre
        `);
        
        res.json({ success: true, data: occupation });
    } catch (error) {
        console.error('Erreur occupation:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * POST /api/planning/placer-manuel
 * Placer manuellement un atelier dans le planning
 */
router.post('/placer-manuel', async (req, res) => {
    try {
        const { atelier_id, salle_id, creneau_debut_id } = req.body;
        
        if (!atelier_id || !salle_id || !creneau_debut_id) {
            return res.status(400).json({
                success: false,
                message: 'Atelier, salle et créneau requis'
            });
        }
        
        // Récupérer info atelier
        const ateliers = await query('SELECT duree FROM ateliers WHERE id = ?', [atelier_id]);
        if (ateliers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Atelier non trouvé'
            });
        }
        
        const duree = ateliers[0].duree;
        const nombreCreneaux = Math.ceil(duree / 2);
        
        // Vérifier si l'atelier n'est pas déjà placé
        const existing = await query('SELECT id FROM planning WHERE atelier_id = ?', [atelier_id]);
        if (existing.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Atelier déjà placé dans le planning'
            });
        }
        
        // Placer
        await query(`
            INSERT INTO planning (atelier_id, salle_id, creneau_debut_id, nombre_creneaux, valide)
            VALUES (?, ?, ?, ?, TRUE)
        `, [atelier_id, salle_id, creneau_debut_id, nombreCreneaux]);
        
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'PLACEMENT_MANUEL', `Atelier ${atelier_id} placé manuellement`]
        );
        
        res.json({
            success: true,
            message: 'Atelier placé avec succès'
        });
    } catch (error) {
        console.error('Erreur placement manuel:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

module.exports = router;
