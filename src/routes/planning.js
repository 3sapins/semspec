const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

router.use(authMiddleware, adminMiddleware);

/**
 * DELETE /api/planning/reset/all
 * Réinitialiser tout le planning (DOIT être avant les routes avec :id)
 */
router.delete('/reset/all', async (req, res) => {
    try {
        // Supprimer d'abord les inscriptions liées au planning
        await query('DELETE FROM inscriptions WHERE planning_id IS NOT NULL');
        // Puis supprimer le planning
        await query('DELETE FROM planning');
        
        await query('INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'RESET_PLANNING', 'Réinitialisation complète du planning']);
        
        res.json({ success: true, message: 'Planning réinitialisé' });
    } catch (error) {
        console.error('Erreur reset planning:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

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
 * GET /api/planning/ateliers-valides
 * Liste de TOUS les ateliers validés (même déjà placés) pour permettre plusieurs itérations
 */
router.get('/ateliers-valides', async (req, res) => {
    try {
        const ateliers = await query(`
            SELECT a.*, u.nom as enseignant_nom, u.prenom as enseignant_prenom,
                (SELECT COUNT(*) FROM planning WHERE atelier_id = a.id) as nb_iterations
            FROM ateliers a
            LEFT JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            WHERE a.statut = 'valide'
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
 * Allocation automatique intelligente avec règles complètes :
 * 1. Répartition équitable des ateliers par enseignant
 * 2. Priorité : 6 périodes (début P1-2) > 4 périodes (P1-2 ou P3-4) > 2 périodes
 * 3. Respect des disponibilités enseignants
 * 4. Respect de la charge max (nombre de périodes)
 * 5. Respect du type de salle demandé
 * 6. Ateliers multi-créneaux sur le même jour
 */
router.post('/allouer', async (req, res) => {
    try {
        console.log('🔄 Début de l\'allocation automatique...');
        
        // 1. Charger tous les ateliers validés non placés
        const ateliers = await query(`
            SELECT a.*, 
                u.nom as enseignant_nom, 
                u.prenom as enseignant_prenom,
                u.charge_max as enseignant_charge_max
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
                ateliers_places: 0,
                ateliers_non_places: 0
            });
        }
        
        console.log(`📋 ${ateliers.length} ateliers à placer`);
        
        // 2. Charger les créneaux ordonnés
        const creneaux = await query('SELECT * FROM creneaux ORDER BY ordre');
        
        // Organiser les créneaux par jour
        const creneauxParJour = {};
        creneaux.forEach(c => {
            if (!creneauxParJour[c.jour]) creneauxParJour[c.jour] = [];
            creneauxParJour[c.jour].push(c);
        });
        
        // 3. Charger les salles disponibles
        const salles = await query('SELECT * FROM salles WHERE disponible = TRUE ORDER BY capacite DESC');
        
        // 4. Charger les disponibilités des enseignants
        const disponibilites = await query('SELECT * FROM disponibilites_enseignants WHERE disponible = TRUE');
        const dispoMap = {};
        disponibilites.forEach(d => {
            if (!dispoMap[d.enseignant_acronyme]) dispoMap[d.enseignant_acronyme] = new Set();
            dispoMap[d.enseignant_acronyme].add(d.creneau_id);
        });
        
        // 5. Charger les charges actuelles des enseignants
        const chargesActuelles = await query(`
            SELECT a.enseignant_acronyme, SUM(a.duree) as charge_utilisee
            FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            GROUP BY a.enseignant_acronyme
        `);
        const chargeMap = {};
        chargesActuelles.forEach(c => {
            chargeMap[c.enseignant_acronyme] = c.charge_utilisee || 0;
        });
        
        // 6. Initialiser les structures d'occupation
        const salleOccupee = {}; // salleOccupee[creneau_id][salle_id] = atelier_id
        const enseignantOccupe = {}; // enseignantOccupe[creneau_id][acronyme] = atelier_id
        creneaux.forEach(c => {
            salleOccupee[c.id] = {};
            enseignantOccupe[c.id] = {};
        });
        
        // Charger les placements existants
        const placementsExistants = await query(`
            SELECT p.*, a.enseignant_acronyme, a.enseignant2_acronyme, a.enseignant3_acronyme, a.duree
            FROM planning p 
            JOIN ateliers a ON p.atelier_id = a.id
        `);
        
        placementsExistants.forEach(p => {
            const nombreCreneaux = Math.ceil(p.duree / 2);
            const indexDebut = creneaux.findIndex(c => c.id === p.creneau_id);
            
            for (let i = 0; i < nombreCreneaux && indexDebut + i < creneaux.length; i++) {
                const creneauId = creneaux[indexDebut + i].id;
                salleOccupee[creneauId][p.salle_id] = p.atelier_id;
                
                // Marquer tous les enseignants comme occupés
                if (p.enseignant_acronyme) enseignantOccupe[creneauId][p.enseignant_acronyme] = p.atelier_id;
                if (p.enseignant2_acronyme) enseignantOccupe[creneauId][p.enseignant2_acronyme] = p.atelier_id;
                if (p.enseignant3_acronyme) enseignantOccupe[creneauId][p.enseignant3_acronyme] = p.atelier_id;
            }
        });
        
        // 7. Trier les ateliers : 6p d'abord, puis 4p, puis 2p
        // Et grouper par enseignant pour une répartition équitable
        const ateliers6p = ateliers.filter(a => a.duree === 6);
        const ateliers4p = ateliers.filter(a => a.duree === 4);
        const ateliers2p = ateliers.filter(a => a.duree === 2);
        
        console.log(`📊 Répartition: ${ateliers6p.length} ateliers 6p, ${ateliers4p.length} ateliers 4p, ${ateliers2p.length} ateliers 2p`);
        
        const resultat = { placed: 0, failed: [] };
        
        // Fonction pour vérifier si un enseignant est disponible sur des créneaux
        function enseignantDisponible(acronyme, creneauxIds) {
            // Si pas de disponibilités définies, l'enseignant est considéré disponible partout
            if (!dispoMap[acronyme] || dispoMap[acronyme].size === 0) return true;
            return creneauxIds.every(id => dispoMap[acronyme].has(id));
        }
        
        // Fonction pour vérifier si un enseignant n'est pas déjà occupé
        function enseignantLibre(acronyme, creneauxIds) {
            return creneauxIds.every(id => !enseignantOccupe[id][acronyme]);
        }
        
        // Fonction pour vérifier la charge max
        function chargeRespectee(acronyme, duree, chargeMax) {
            if (!chargeMax || chargeMax === 0) return true; // Pas de limite
            const chargeActuelle = chargeMap[acronyme] || 0;
            return (chargeActuelle + duree) <= chargeMax;
        }
        
        // Fonction pour trouver une salle compatible
        function trouverSalle(atelier, creneauxIds) {
            for (const salle of salles) {
                // Vérifier capacité
                if (salle.capacite < atelier.nombre_places_max) continue;
                
                // Vérifier type de salle si demandé
                if (atelier.type_salle_demande && atelier.type_salle_demande !== '') {
                    if (salle.type_salle !== atelier.type_salle_demande) continue;
                }
                
                // Vérifier disponibilité sur tous les créneaux
                const salleLibre = creneauxIds.every(id => !salleOccupee[id][salle.id]);
                if (salleLibre) return salle;
            }
            return null;
        }
        
        // Fonction pour placer un atelier
        async function placerAtelier(atelier) {
            const nombreCreneaux = Math.ceil(atelier.duree / 2);
            const acronyme = atelier.enseignant_acronyme;
            const chargeMax = atelier.enseignant_charge_max;
            
            // Vérifier la charge max avant de tenter le placement
            if (!chargeRespectee(acronyme, atelier.duree, chargeMax)) {
                return { success: false, raison: `Charge max dépassée pour ${acronyme}` };
            }
            
            // Définir les créneaux de début autorisés selon la durée
            let creneauxDebutAutorises = [];
            
            if (atelier.duree === 6) {
                // 6 périodes = journée complète, doit commencer en P1-2
                Object.keys(creneauxParJour).forEach(jour => {
                    const creneauxJour = creneauxParJour[jour];
                    if (creneauxJour.length >= 3) {
                        const p12 = creneauxJour.find(c => c.periode === 'P1-2');
                        if (p12) creneauxDebutAutorises.push({ jour, creneau: p12, creneauxJour });
                    }
                });
            } else if (atelier.duree === 4) {
                // 4 périodes = demi-journée, peut commencer en P1-2 (matin) ou P3-4 (après-midi si pas mercredi)
                Object.keys(creneauxParJour).forEach(jour => {
                    const creneauxJour = creneauxParJour[jour];
                    // Matin : P1-2 suivi de P3-4
                    const p12 = creneauxJour.find(c => c.periode === 'P1-2');
                    const p34 = creneauxJour.find(c => c.periode === 'P3-4');
                    if (p12 && p34) creneauxDebutAutorises.push({ jour, creneau: p12, creneauxJour });
                    
                    // Après-midi : P3-4 suivi de P6-7 (sauf mercredi)
                    if (jour !== 'mercredi') {
                        const p67 = creneauxJour.find(c => c.periode === 'P6-7');
                        if (p34 && p67) creneauxDebutAutorises.push({ jour, creneau: p34, creneauxJour });
                    }
                });
            } else {
                // 2 périodes = 1 créneau, peut être n'importe où
                Object.keys(creneauxParJour).forEach(jour => {
                    const creneauxJour = creneauxParJour[jour];
                    creneauxJour.forEach(c => {
                        creneauxDebutAutorises.push({ jour, creneau: c, creneauxJour });
                    });
                });
            }
            
            // Essayer chaque créneau de début autorisé
            for (const { jour, creneau, creneauxJour } of creneauxDebutAutorises) {
                const indexDansJour = creneauxJour.findIndex(c => c.id === creneau.id);
                
                // Vérifier qu'on a assez de créneaux dans le jour
                if (indexDansJour + nombreCreneaux > creneauxJour.length) continue;
                
                // Récupérer les créneaux nécessaires
                const creneauxNecessaires = [];
                for (let i = 0; i < nombreCreneaux; i++) {
                    creneauxNecessaires.push(creneauxJour[indexDansJour + i]);
                }
                const creneauxIds = creneauxNecessaires.map(c => c.id);
                
                // Vérifier disponibilité enseignant principal
                if (!enseignantDisponible(acronyme, creneauxIds)) continue;
                if (!enseignantLibre(acronyme, creneauxIds)) continue;
                
                // Vérifier disponibilité enseignants supplémentaires
                if (atelier.enseignant2_acronyme) {
                    if (!enseignantDisponible(atelier.enseignant2_acronyme, creneauxIds)) continue;
                    if (!enseignantLibre(atelier.enseignant2_acronyme, creneauxIds)) continue;
                }
                if (atelier.enseignant3_acronyme) {
                    if (!enseignantDisponible(atelier.enseignant3_acronyme, creneauxIds)) continue;
                    if (!enseignantLibre(atelier.enseignant3_acronyme, creneauxIds)) continue;
                }
                
                // Trouver une salle
                const salle = trouverSalle(atelier, creneauxIds);
                if (!salle) continue;
                
                // Placer l'atelier !
                try {
                    await query(`
                        INSERT INTO planning (atelier_id, salle_id, creneau_id, nombre_creneaux, valide) 
                        VALUES (?, ?, ?, ?, TRUE)
                    `, [atelier.id, salle.id, creneau.id, nombreCreneaux]);
                    
                    // Mettre à jour les structures d'occupation
                    creneauxIds.forEach(id => {
                        salleOccupee[id][salle.id] = atelier.id;
                        enseignantOccupe[id][acronyme] = atelier.id;
                        if (atelier.enseignant2_acronyme) enseignantOccupe[id][atelier.enseignant2_acronyme] = atelier.id;
                        if (atelier.enseignant3_acronyme) enseignantOccupe[id][atelier.enseignant3_acronyme] = atelier.id;
                    });
                    
                    // Mettre à jour la charge
                    chargeMap[acronyme] = (chargeMap[acronyme] || 0) + atelier.duree;
                    
                    console.log(`✅ "${atelier.nom}" placé: ${jour} ${creneau.periode} en ${salle.nom}`);
                    return { success: true };
                    
                } catch (error) {
                    console.error(`❌ Erreur placement ${atelier.nom}:`, error);
                }
            }
            
            return { success: false, raison: 'Aucun créneau/salle disponible' };
        }
        
        // 8. Placer les ateliers par ordre de priorité
        
        // 8a. D'abord les ateliers de 6 périodes
        console.log('📌 Placement des ateliers 6 périodes...');
        for (const atelier of ateliers6p) {
            const result = await placerAtelier(atelier);
            if (result.success) {
                resultat.placed++;
            } else {
                resultat.failed.push({ id: atelier.id, nom: atelier.nom, raison: result.raison });
            }
        }
        
        // 8b. Puis les ateliers de 4 périodes
        console.log('📌 Placement des ateliers 4 périodes...');
        for (const atelier of ateliers4p) {
            const result = await placerAtelier(atelier);
            if (result.success) {
                resultat.placed++;
            } else {
                resultat.failed.push({ id: atelier.id, nom: atelier.nom, raison: result.raison });
            }
        }
        
        // 8c. Enfin les ateliers de 2 périodes
        console.log('📌 Placement des ateliers 2 périodes...');
        for (const atelier of ateliers2p) {
            const result = await placerAtelier(atelier);
            if (result.success) {
                resultat.placed++;
            } else {
                resultat.failed.push({ id: atelier.id, nom: atelier.nom, raison: result.raison });
            }
        }
        
        // 9. Log et réponse
        await query('INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'AUTO_ALLOCATION', `${resultat.placed} ateliers placés, ${resultat.failed.length} échecs`]);
        
        console.log(`🏁 Allocation terminée: ${resultat.placed} placés, ${resultat.failed.length} échecs`);
        if (resultat.failed.length > 0) {
            console.log('❌ Échecs:', resultat.failed.map(f => `${f.nom}: ${f.raison}`).join(', '));
        }
        
        res.json({ 
            success: true, 
            message: `${resultat.placed} ateliers placés sur ${ateliers.length}`,
            ateliers_places: resultat.placed,
            ateliers_non_places: resultat.failed.length,
            echecs: resultat.failed
        });
        
    } catch (error) {
        console.error('Erreur allocation:', error);
        res.status(500).json({ success: false, message: 'Erreur: ' + error.message });
    }
});

/**
 * POST /api/planning/placer-manuel
 * Permet de placer un atelier validé (même s'il a déjà des placements - plusieurs itérations)
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
        
        // Récupérer tous les créneaux pour calculer correctement les créneaux consécutifs
        const tousCreneaux = await query('SELECT * FROM creneaux ORDER BY ordre');
        const creneauDebut = tousCreneaux.find(c => c.id === parseInt(creneau_id));
        if (!creneauDebut) {
            return res.status(404).json({ success: false, message: 'Créneau non trouvé' });
        }
        
        // Calculer les IDs des créneaux à occuper (basé sur l'ordre, pas l'ID)
        const indexDebut = tousCreneaux.findIndex(c => c.id === parseInt(creneau_id));
        const creneauxToCheck = [];
        for (let i = 0; i < nombreCreneaux; i++) {
            if (indexDebut + i < tousCreneaux.length) {
                creneauxToCheck.push(tousCreneaux[indexDebut + i].id);
            }
        }
        
        if (creneauxToCheck.length < nombreCreneaux) {
            return res.status(400).json({ success: false, message: 'Pas assez de créneaux disponibles à partir de ce point' });
        }
        
        // Vérifier que les créneaux sont sur le même jour
        const jourDebut = creneauDebut.jour;
        const creneauxMemeJour = creneauxToCheck.every(id => {
            const c = tousCreneaux.find(cr => cr.id === id);
            return c && c.jour === jourDebut;
        });
        if (!creneauxMemeJour) {
            return res.status(400).json({ success: false, message: 'L\'atelier ne peut pas déborder sur plusieurs jours' });
        }
        
        // Vérifier conflits salle (exclure l'atelier lui-même s'il a déjà des placements)
        const conflitSalle = await query(`
            SELECT a.nom as atelier_nom FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            WHERE p.salle_id = ? AND p.creneau_id IN (?) AND p.atelier_id != ?
        `, [salle_id, creneauxToCheck, atelier_id]);
        
        if (conflitSalle.length > 0) {
            return res.status(400).json({ success: false, message: `Conflit: salle occupée par "${conflitSalle[0].atelier_nom}"` });
        }
        
        // Vérifier conflits enseignant (exclure l'atelier lui-même)
        const conflitEnseignant = await query(`
            SELECT a.nom as atelier_nom FROM planning p
            JOIN ateliers a ON p.atelier_id = a.id
            WHERE (a.enseignant_acronyme = ? OR a.enseignant2_acronyme = ? OR a.enseignant3_acronyme = ?)
              AND p.creneau_id IN (?) AND p.atelier_id != ?
        `, [atelier.enseignant_acronyme, atelier.enseignant_acronyme, atelier.enseignant_acronyme, creneauxToCheck, atelier_id]);
        
        if (conflitEnseignant.length > 0) {
            return res.status(400).json({ success: false, message: `Conflit: enseignant déjà sur "${conflitEnseignant[0].atelier_nom}"` });
        }
        
        // Vérifier si l'atelier n'est pas déjà placé exactement au même créneau
        const memeCreneauExiste = await query('SELECT id FROM planning WHERE atelier_id = ? AND creneau_id = ?', [atelier_id, creneau_id]);
        if (memeCreneauExiste.length > 0) {
            return res.status(400).json({ success: false, message: 'Cet atelier est déjà placé sur ce créneau' });
        }
        
        await query(`INSERT INTO planning (atelier_id, salle_id, creneau_id, nombre_creneaux, valide) VALUES (?, ?, ?, ?, TRUE)`,
            [atelier_id, salle_id, creneau_id, nombreCreneaux]);
        
        // Compter le nombre d'itérations
        const iterations = await query('SELECT COUNT(*) as nb FROM planning WHERE atelier_id = ?', [atelier_id]);
        
        await query('INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'PLACEMENT_MANUEL', `Atelier "${atelier.nom}" placé (itération ${iterations[0].nb})`]);
        
        res.json({ success: true, message: `Atelier "${atelier.nom}" placé avec succès (itération ${iterations[0].nb})` });
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
