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
 * Allocation automatique intelligente - NOUVELLE LOGIQUE
 * 
 * PRIORITÉ 1: Ateliers multi-enseignants (2 ou 3 enseignants) - plus contraignants
 * PRIORITÉ 2: Un atelier de chaque enseignant (round-robin équitable)
 * PRIORITÉ 3: Multiplication en round-robin jusqu'à remplir les charges
 * 
 * Contraintes:
 * - Un enseignant ne peut PAS avoir 2 activités au même créneau (atelier, piquet, dégagement)
 * - Répartition équitable sur tous les jours de la semaine
 * - Priorité durée : 6 périodes > 4 périodes > 2 périodes
 * - Respect des disponibilités enseignants
 * - Respect de la charge max (nombre de périodes)
 * - Respect du type de salle demandé
 * - Ateliers multi-créneaux sur le même jour
 */
router.post('/allouer', async (req, res) => {
    try {
        console.log('');
        console.log('╔══════════════════════════════════════════════════════════════╗');
        console.log('║       🔄 ALLOCATION AUTOMATIQUE - NOUVELLE LOGIQUE           ║');
        console.log('╚══════════════════════════════════════════════════════════════╝');
        
        // 1. Charger tous les ateliers validés
        const ateliersBase = await query(`
            SELECT a.*, 
                u.nom as enseignant_nom, 
                u.prenom as enseignant_prenom,
                COALESCE(u.charge_max, 0) as enseignant_charge_max
            FROM ateliers a
            LEFT JOIN utilisateurs u ON a.enseignant_acronyme = u.acronyme
            WHERE a.statut = 'valide'
            ORDER BY a.duree DESC, a.nombre_places_max DESC
        `);
        
        if (ateliersBase.length === 0) {
            return res.json({ 
                success: true, 
                message: 'Aucun atelier validé', 
                ateliers_places: 0,
                ateliers_non_places: 0
            });
        }
        
        console.log(`📋 ${ateliersBase.length} ateliers validés à répartir`);
        
        // 2. Charger les créneaux ordonnés
        const creneaux = await query('SELECT * FROM creneaux ORDER BY ordre');
        
        // Organiser les créneaux par jour
        const joursOrdre = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi'];
        const creneauxParJour = {};
        joursOrdre.forEach(jour => { creneauxParJour[jour] = []; });
        creneaux.forEach(c => {
            if (creneauxParJour[c.jour]) creneauxParJour[c.jour].push(c);
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
        
        // 5. Charger les charges max
        const enseignantsData = await query(`SELECT acronyme, COALESCE(charge_max, 0) as charge_max FROM utilisateurs WHERE role = 'enseignant'`);
        const chargeMaxMap = {};
        enseignantsData.forEach(e => { chargeMaxMap[e.acronyme] = e.charge_max; });
        
        const chargesActuelles = await query(`
            SELECT a.enseignant_acronyme, SUM(a.duree) as charge_utilisee
            FROM planning p JOIN ateliers a ON p.atelier_id = a.id
            GROUP BY a.enseignant_acronyme
        `);
        const chargeMap = {};
        chargesActuelles.forEach(c => { chargeMap[c.enseignant_acronyme] = c.charge_utilisee || 0; });
        
        // 6. Charger les piquets/dégagements (NOUVEAU)
        const piquets = await query(`
            SELECT ep.utilisateur_id, ep.creneau_id, u.acronyme
            FROM enseignants_piquet ep
            JOIN utilisateurs u ON ep.utilisateur_id = u.id
        `);
        const piquetMap = {}; // acronyme -> Set de creneau_ids
        piquets.forEach(p => {
            if (!piquetMap[p.acronyme]) piquetMap[p.acronyme] = new Set();
            piquetMap[p.acronyme].add(p.creneau_id);
        });
        console.log(`🚨 ${piquets.length} piquets/dégagements chargés`);
        
        // 7. Initialiser les structures d'occupation
        const salleOccupee = {};
        const enseignantOccupe = {};
        creneaux.forEach(c => {
            salleOccupee[c.id] = {};
            enseignantOccupe[c.id] = {};
        });
        
        // Marquer les enseignants occupés par piquet/dégagement
        piquets.forEach(p => {
            if (enseignantOccupe[p.creneau_id]) {
                enseignantOccupe[p.creneau_id][p.acronyme] = 'PIQUET';
            }
        });
        
        const occupationParJour = {};
        joursOrdre.forEach(jour => { occupationParJour[jour] = 0; });
        
        // Tracker : combien de fois chaque atelier a été placé
        const atelierIterations = {};
        ateliersBase.forEach(a => { atelierIterations[a.id] = 0; });
        
        // Charger les placements existants
        const placementsExistants = await query(`
            SELECT p.*, a.enseignant_acronyme, a.enseignant2_acronyme, a.enseignant3_acronyme, a.duree, c.jour
            FROM planning p JOIN ateliers a ON p.atelier_id = a.id JOIN creneaux c ON p.creneau_id = c.id
        `);
        
        placementsExistants.forEach(p => {
            atelierIterations[p.atelier_id] = (atelierIterations[p.atelier_id] || 0) + 1;
            occupationParJour[p.jour] = (occupationParJour[p.jour] || 0) + 1;
            
            const nombreCreneaux = Math.ceil(p.duree / 2);
            const indexDebut = creneaux.findIndex(c => c.id === p.creneau_id);
            
            for (let i = 0; i < nombreCreneaux && indexDebut + i < creneaux.length; i++) {
                const creneauId = creneaux[indexDebut + i].id;
                salleOccupee[creneauId][p.salle_id] = p.atelier_id;
                if (p.enseignant_acronyme) enseignantOccupe[creneauId][p.enseignant_acronyme] = p.atelier_id;
                if (p.enseignant2_acronyme) enseignantOccupe[creneauId][p.enseignant2_acronyme] = p.atelier_id;
                if (p.enseignant3_acronyme) enseignantOccupe[creneauId][p.enseignant3_acronyme] = p.atelier_id;
            }
        });
        
        // Catégoriser les ateliers
        const ateliersMultiEns = ateliersBase.filter(a => a.enseignant2_acronyme || a.enseignant3_acronyme);
        const ateliersMonoEns = ateliersBase.filter(a => !a.enseignant2_acronyme && !a.enseignant3_acronyme);
        
        // Grouper les ateliers mono par enseignant
        const ateliersParEnseignant = {};
        ateliersMonoEns.forEach(a => {
            if (!ateliersParEnseignant[a.enseignant_acronyme]) {
                ateliersParEnseignant[a.enseignant_acronyme] = [];
            }
            ateliersParEnseignant[a.enseignant_acronyme].push(a);
        });
        
        // Trier les ateliers de chaque enseignant par durée (6p > 4p > 2p)
        Object.keys(ateliersParEnseignant).forEach(acr => {
            ateliersParEnseignant[acr].sort((a, b) => b.duree - a.duree);
        });
        
        console.log(`📊 ${ateliersMultiEns.length} ateliers multi-enseignants, ${ateliersMonoEns.length} mono-enseignant`);
        console.log(`👥 ${Object.keys(ateliersParEnseignant).length} enseignants avec ateliers`);
        
        const resultat = { placed: 0, failed: [], iterations: [] };
        
        // ═══════════════════════════════════════════════════════════
        // FONCTIONS UTILITAIRES
        // ═══════════════════════════════════════════════════════════
        
        function getJoursTriesParOccupation() {
            return [...joursOrdre].sort((a, b) => occupationParJour[a] - occupationParJour[b]);
        }
        
        function enseignantDisponible(acronyme, creneauxIds) {
            if (!dispoMap[acronyme] || dispoMap[acronyme].size === 0) return true;
            return creneauxIds.every(id => dispoMap[acronyme].has(id));
        }
        
        function enseignantLibre(acronyme, creneauxIds) {
            // Vérifie atelier OU piquet/dégagement
            return creneauxIds.every(id => !enseignantOccupe[id][acronyme]);
        }
        
        function chargeRestante(acronyme) {
            const chargeMax = chargeMaxMap[acronyme] || 0;
            if (chargeMax === 0) return 999;
            return chargeMax - (chargeMap[acronyme] || 0);
        }
        
        function trouverSalle(atelier, creneauxIds) {
            for (const salle of salles) {
                if (salle.capacite < atelier.nombre_places_max) continue;
                if (atelier.type_salle_demande && atelier.type_salle_demande !== '' && salle.type_salle !== atelier.type_salle_demande) continue;
                if (creneauxIds.every(id => !salleOccupee[id][salle.id])) return salle;
            }
            return null;
        }
        
        function getCreneauxDebut(duree, jour) {
            const creneauxJour = creneauxParJour[jour];
            const possibles = [];
            
            if (duree === 6) {
                if (creneauxJour.length >= 3) {
                    const p12 = creneauxJour.find(c => c.periode === 'P1-2');
                    if (p12) possibles.push({ creneau: p12, creneauxJour });
                }
            } else if (duree === 4) {
                const p12 = creneauxJour.find(c => c.periode === 'P1-2');
                const p34 = creneauxJour.find(c => c.periode === 'P3-4');
                const p67 = creneauxJour.find(c => c.periode === 'P6-7');
                if (p12 && p34) possibles.push({ creneau: p12, creneauxJour });
                if (jour !== 'mercredi' && p34 && p67) possibles.push({ creneau: p34, creneauxJour });
            } else {
                creneauxJour.forEach(c => possibles.push({ creneau: c, creneauxJour }));
            }
            return possibles;
        }
        
        async function placerAtelierSurJour(atelier, jour, ignoreChargeMax = false) {
            const nombreCreneaux = Math.ceil(atelier.duree / 2);
            const acronyme = atelier.enseignant_acronyme;
            
            if (!ignoreChargeMax && chargeRestante(acronyme) < atelier.duree) {
                return { success: false, raison: 'Charge max atteinte' };
            }
            
            const creneauxDebut = getCreneauxDebut(atelier.duree, jour);
            
            for (const { creneau, creneauxJour } of creneauxDebut) {
                const indexDansJour = creneauxJour.findIndex(c => c.id === creneau.id);
                if (indexDansJour + nombreCreneaux > creneauxJour.length) continue;
                
                const creneauxNecessaires = [];
                for (let i = 0; i < nombreCreneaux; i++) {
                    creneauxNecessaires.push(creneauxJour[indexDansJour + i]);
                }
                const creneauxIds = creneauxNecessaires.map(c => c.id);
                
                // Vérifier TOUS les enseignants
                if (!enseignantDisponible(acronyme, creneauxIds)) continue;
                if (!enseignantLibre(acronyme, creneauxIds)) continue;
                
                if (atelier.enseignant2_acronyme) {
                    if (!enseignantDisponible(atelier.enseignant2_acronyme, creneauxIds)) continue;
                    if (!enseignantLibre(atelier.enseignant2_acronyme, creneauxIds)) continue;
                }
                if (atelier.enseignant3_acronyme) {
                    if (!enseignantDisponible(atelier.enseignant3_acronyme, creneauxIds)) continue;
                    if (!enseignantLibre(atelier.enseignant3_acronyme, creneauxIds)) continue;
                }
                
                const salle = trouverSalle(atelier, creneauxIds);
                if (!salle) continue;
                
                try {
                    await query(`INSERT INTO planning (atelier_id, salle_id, creneau_id, nombre_creneaux, valide) VALUES (?, ?, ?, ?, TRUE)`,
                        [atelier.id, salle.id, creneau.id, nombreCreneaux]);
                    
                    creneauxIds.forEach(id => {
                        salleOccupee[id][salle.id] = atelier.id;
                        enseignantOccupe[id][acronyme] = atelier.id;
                        if (atelier.enseignant2_acronyme) enseignantOccupe[id][atelier.enseignant2_acronyme] = atelier.id;
                        if (atelier.enseignant3_acronyme) enseignantOccupe[id][atelier.enseignant3_acronyme] = atelier.id;
                    });
                    
                    chargeMap[acronyme] = (chargeMap[acronyme] || 0) + atelier.duree;
                    occupationParJour[jour]++;
                    atelierIterations[atelier.id]++;
                    
                    return { success: true, jour, creneau: creneau.periode, salle: salle.nom };
                } catch (error) {
                    console.error(`❌ Erreur placement:`, error);
                }
            }
            return { success: false, raison: 'Pas de créneau disponible' };
        }
        
        async function placerAtelier(atelier, ignoreChargeMax = false) {
            for (const jour of getJoursTriesParOccupation()) {
                const result = await placerAtelierSurJour(atelier, jour, ignoreChargeMax);
                if (result.success) return result;
            }
            return { success: false, raison: 'Aucun créneau/salle disponible' };
        }
        
        // ═══════════════════════════════════════════════════════════
        // PHASE 1 : Ateliers multi-enseignants (plus contraignants)
        // ═══════════════════════════════════════════════════════════
        console.log('');
        console.log('═══════════════════════════════════════════════════════');
        console.log('📌 PHASE 1: Ateliers multi-enseignants');
        console.log('═══════════════════════════════════════════════════════');
        
        // Trier par nombre d'enseignants (3 > 2) puis par durée
        ateliersMultiEns.sort((a, b) => {
            const nbEnsA = (a.enseignant2_acronyme ? 1 : 0) + (a.enseignant3_acronyme ? 1 : 0);
            const nbEnsB = (b.enseignant2_acronyme ? 1 : 0) + (b.enseignant3_acronyme ? 1 : 0);
            if (nbEnsB !== nbEnsA) return nbEnsB - nbEnsA;
            return b.duree - a.duree;
        });
        
        for (const atelier of ateliersMultiEns) {
            if (atelierIterations[atelier.id] > 0) continue; // Déjà placé
            
            const result = await placerAtelier(atelier, true);
            if (result.success) {
                resultat.placed++;
                resultat.iterations.push({ atelier: atelier.nom, iteration: 1, phase: 'multi-ens', jour: result.jour, creneau: result.creneau, salle: result.salle });
                console.log(`✅ [Multi-Ens] "${atelier.nom}": ${result.jour} ${result.creneau} en ${result.salle}`);
            } else {
                resultat.failed.push({ id: atelier.id, nom: atelier.nom, enseignant: atelier.enseignant_acronyme, raison: result.raison });
                console.log(`❌ [Multi-Ens] "${atelier.nom}": ${result.raison}`);
            }
        }
        
        // ═══════════════════════════════════════════════════════════
        // PHASE 2 : Un atelier de chaque enseignant (round-robin)
        // ═══════════════════════════════════════════════════════════
        console.log('');
        console.log('═══════════════════════════════════════════════════════');
        console.log('📌 PHASE 2: Un atelier de chaque enseignant (round-robin)');
        console.log('═══════════════════════════════════════════════════════');
        
        const enseignantsListe = Object.keys(ateliersParEnseignant);
        const indexParEnseignant = {};
        enseignantsListe.forEach(acr => { indexParEnseignant[acr] = 0; });
        
        let ateliersRestants = true;
        while (ateliersRestants) {
            ateliersRestants = false;
            
            for (const acronyme of enseignantsListe) {
                const ateliers = ateliersParEnseignant[acronyme];
                const index = indexParEnseignant[acronyme];
                
                // Trouver le prochain atelier non encore placé pour cet enseignant
                let atelierAPlace = null;
                for (let i = index; i < ateliers.length; i++) {
                    if (atelierIterations[ateliers[i].id] === 0) {
                        atelierAPlace = ateliers[i];
                        indexParEnseignant[acronyme] = i + 1;
                        break;
                    }
                }
                
                if (!atelierAPlace) continue;
                ateliersRestants = true;
                
                const result = await placerAtelier(atelierAPlace, true);
                if (result.success) {
                    resultat.placed++;
                    resultat.iterations.push({ atelier: atelierAPlace.nom, iteration: 1, phase: 'initial', jour: result.jour, creneau: result.creneau, salle: result.salle });
                    console.log(`✅ [Initial] "${atelierAPlace.nom}" (${acronyme}): ${result.jour} ${result.creneau} en ${result.salle}`);
                } else {
                    resultat.failed.push({ id: atelierAPlace.id, nom: atelierAPlace.nom, enseignant: acronyme, raison: result.raison });
                    console.log(`❌ [Initial] "${atelierAPlace.nom}" (${acronyme}): ${result.raison}`);
                }
            }
        }
        
        // ═══════════════════════════════════════════════════════════
        // PHASE 3 : Multiplication round-robin pour remplir les charges
        // ═══════════════════════════════════════════════════════════
        console.log('');
        console.log('═══════════════════════════════════════════════════════');
        console.log('📌 PHASE 3: Multiplication round-robin');
        console.log('═══════════════════════════════════════════════════════');
        
        // Récupérer tous les ateliers placés au moins une fois
        const ateliersPlaces = ateliersBase.filter(a => atelierIterations[a.id] > 0);
        
        // Grouper par enseignant
        const ateliersPlacesParEns = {};
        ateliersPlaces.forEach(a => {
            if (!ateliersPlacesParEns[a.enseignant_acronyme]) {
                ateliersPlacesParEns[a.enseignant_acronyme] = [];
            }
            ateliersPlacesParEns[a.enseignant_acronyme].push(a);
        });
        
        // Trier par durée décroissante dans chaque groupe
        Object.keys(ateliersPlacesParEns).forEach(acr => {
            ateliersPlacesParEns[acr].sort((a, b) => b.duree - a.duree);
        });
        
        const enseignantsAvecCharge = Object.keys(ateliersPlacesParEns);
        const indexMulti = {};
        enseignantsAvecCharge.forEach(acr => { indexMulti[acr] = 0; });
        
        let continuerMulti = true;
        let passeSansPlacement = 0;
        const MAX_PASSES_SANS_PLACEMENT = 3;
        
        while (continuerMulti && passeSansPlacement < MAX_PASSES_SANS_PLACEMENT) {
            let placementCettePasse = false;
            
            for (const acronyme of enseignantsAvecCharge) {
                // Vérifier s'il reste de la charge
                if (chargeRestante(acronyme) <= 0) continue;
                
                const ateliers = ateliersPlacesParEns[acronyme];
                if (!ateliers || ateliers.length === 0) continue;
                
                // Round-robin : prendre l'atelier suivant
                const index = indexMulti[acronyme] % ateliers.length;
                const atelier = ateliers[index];
                indexMulti[acronyme]++;
                
                // Vérifier si la charge permet de placer cet atelier
                if (chargeRestante(acronyme) < atelier.duree) continue;
                
                const result = await placerAtelier(atelier, false);
                if (result.success) {
                    resultat.placed++;
                    const iterNum = atelierIterations[atelier.id];
                    resultat.iterations.push({ atelier: atelier.nom, iteration: iterNum, phase: 'multi', jour: result.jour, creneau: result.creneau, salle: result.salle });
                    console.log(`✅ [Multi] "${atelier.nom}" #${iterNum} (${acronyme}): ${result.jour} ${result.creneau} en ${result.salle}`);
                    placementCettePasse = true;
                }
            }
            
            if (!placementCettePasse) {
                passeSansPlacement++;
            } else {
                passeSansPlacement = 0;
            }
            
            // Vérifier s'il reste des enseignants avec de la charge disponible
            continuerMulti = enseignantsAvecCharge.some(acr => chargeRestante(acr) > 0);
        }
        
        // ═══════════════════════════════════════════════════════════
        // RÉSULTAT FINAL
        // ═══════════════════════════════════════════════════════════
        
        await query('INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [req.user.id, 'AUTO_ALLOCATION', `${resultat.placed} placements, ${resultat.failed.length} échecs`]);
        
        const ateliersUniquesPlaces = Object.values(atelierIterations).filter(n => n > 0).length;
        
        console.log('');
        console.log('╔══════════════════════════════════════════════════════════════╗');
        console.log(`║  🏁 ALLOCATION TERMINÉE: ${resultat.placed} placements                      `);
        console.log('╚══════════════════════════════════════════════════════════════╝');
        console.log(`📊 Répartition jours:`, occupationParJour);
        console.log(`✅ Ateliers uniques placés: ${ateliersUniquesPlaces}/${ateliersBase.length}`);
        if (resultat.failed.length > 0) {
            console.log(`❌ Échecs: ${resultat.failed.map(f => f.nom).join(', ')}`);
        }
        
        res.json({ 
            success: true, 
            message: `${resultat.placed} placements effectués`,
            ateliers_places: resultat.placed,
            ateliers_uniques_places: ateliersUniquesPlaces,
            ateliers_total: ateliersBase.length,
            ateliers_non_places: resultat.failed.length,
            repartition_jours: occupationParJour,
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
        
        // Charger aussi les piquets/dégagements
        let piquets = [];
        try {
            piquets = await query(`
                SELECT ep.id, ep.utilisateur_id, ep.creneau_id, ep.type,
                    u.nom as enseignant_nom, u.prenom as enseignant_prenom, u.acronyme as enseignant_acronyme,
                    c.jour, c.periode, c.ordre,
                    'Salle des maîtres' as salle_nom
                FROM enseignants_piquet ep
                JOIN utilisateurs u ON ep.utilisateur_id = u.id
                JOIN creneaux c ON ep.creneau_id = c.id
                ORDER BY c.ordre
            `);
        } catch (e) {
            console.error('Erreur chargement piquets pour grid:', e);
        }
        
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
        
        // Ajouter les piquets dans la "Salle des maîtres"
        piquets.forEach(p => {
            if (!grid[p.jour]) grid[p.jour] = {};
            if (!grid[p.jour][p.periode]) grid[p.jour][p.periode] = {};
            
            const salleName = 'Salle des maîtres';
            
            // Si plusieurs enseignants en piquet sur le même créneau, on les cumule
            if (grid[p.jour][p.periode][salleName]) {
                // Ajouter l'enseignant à la liste existante
                const existing = grid[p.jour][p.periode][salleName];
                if (existing.enseignants_list) {
                    existing.enseignants_list.push(`${p.enseignant_prenom} ${p.enseignant_nom}`);
                    existing.enseignant_acronyme += `, ${p.enseignant_acronyme}`;
                } else {
                    existing.enseignants_list = [existing.atelier_nom.replace('🚨 ', '').replace('📋 ', ''), `${p.enseignant_prenom} ${p.enseignant_nom}`];
                }
                existing.atelier_nom = p.type === 'piquet' ? '🚨 Piquet' : '📋 Dégagement';
            } else {
                grid[p.jour][p.periode][salleName] = {
                    planning_id: null,
                    atelier_id: null,
                    atelier_nom: p.type === 'piquet' ? '🚨 Piquet' : '📋 Dégagement',
                    enseignant_acronyme: p.enseignant_acronyme,
                    enseignants: `${p.enseignant_prenom} ${p.enseignant_nom}`,
                    nombre_inscrits: null,
                    nombre_places_max: null,
                    nombre_creneaux: 1,
                    duree: 2,
                    type: p.type,
                    is_piquet: true
                };
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
