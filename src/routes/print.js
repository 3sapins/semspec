const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const jwt = require('jsonwebtoken');

// Middleware d'authentification qui accepte aussi le token en query string (pour les impressions)
const printAuthMiddleware = async (req, res, next) => {
    try {
        // Token dans header OU dans query string
        let token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
        
        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token d\'authentification manquant'
            });
        }
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'semaine-speciale-secret-key');
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: 'Token invalide'
        });
    }
};

// Toutes les routes nécessitent authentification
router.use(printAuthMiddleware);

// ============================================================
// UTILITAIRES PDF (génération HTML pour impression navigateur)
// ============================================================

/**
 * Génère le header HTML commun pour tous les documents
 */
function generateHtmlHeader(title, subtitle = '') {
    return `
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: Arial, sans-serif;
            font-size: 11pt;
            color: #333;
            padding: 15mm;
        }
        
        @media print {
            body { padding: 10mm; }
            .no-print { display: none !important; }
            .page-break { page-break-before: always; }
        }
        
        .header {
            text-align: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 2px solid #667eea;
        }
        
        .header h1 {
            font-size: 18pt;
            color: #667eea;
            margin-bottom: 5px;
        }
        
        .header h2 {
            font-size: 14pt;
            color: #333;
            font-weight: normal;
        }
        
        .header .subtitle {
            font-size: 10pt;
            color: #666;
            margin-top: 5px;
        }
        
        .info-box {
            background: #f3f4f6;
            padding: 10px 15px;
            border-radius: 5px;
            margin-bottom: 15px;
        }
        
        .info-box p {
            margin: 3px 0;
        }
        
        .info-box strong {
            color: #667eea;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
        }
        
        th, td {
            border: 1px solid #ddd;
            padding: 8px 10px;
            text-align: left;
        }
        
        th {
            background: #667eea;
            color: white;
            font-weight: 600;
        }
        
        tr:nth-child(even) {
            background: #f9fafb;
        }
        
        tr:hover {
            background: #f0f0f0;
        }
        
        .checkbox {
            width: 18px;
            height: 18px;
            border: 2px solid #333;
            display: inline-block;
        }
        
        .footer {
            margin-top: 30px;
            padding-top: 15px;
            border-top: 1px solid #ddd;
            font-size: 9pt;
            color: #666;
            text-align: center;
        }
        
        .stats {
            display: flex;
            gap: 20px;
            margin: 15px 0;
        }
        
        .stat-box {
            background: #f3f4f6;
            padding: 10px 20px;
            border-radius: 5px;
            text-align: center;
        }
        
        .stat-value {
            font-size: 20pt;
            font-weight: bold;
            color: #667eea;
        }
        
        .stat-label {
            font-size: 9pt;
            color: #666;
        }
        
        .absent { color: #ef4444; font-weight: bold; }
        .present { color: #10b981; }
        
        .print-btn {
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 10px 25px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
        }
        
        .print-btn:hover {
            background: #5a67d8;
        }
    </style>
</head>
<body>
    <button class="print-btn no-print" onclick="window.print()">🖨️ Imprimer</button>
    <div class="header">
        <h1>${title}</h1>
        ${subtitle ? `<h2>${subtitle}</h2>` : ''}
        <p class="subtitle">Collège des Trois-Sapins, Echallens</p>
    </div>
`;
}

function generateHtmlFooter() {
    const now = new Date().toLocaleString('fr-CH');
    return `
    <div class="footer">
        Document généré le ${now}
    </div>
</body>
</html>
`;
}

// ============================================================
// LISTES DE PRÉSENCE
// ============================================================

/**
 * GET /api/print/presence/:atelierId/:creneauId
 * PDF liste de présence d'un atelier
 */
router.get('/presence/:atelierId/:creneauId', async (req, res) => {
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
                a.id, a.nom,
                cr.jour, cr.periode,
                s.nom as salle_nom,
                GROUP_CONCAT(DISTINCT CONCAT(u.prenom, ' ', u.nom) SEPARATOR ', ') as enseignants
            FROM ateliers a
            JOIN planning pl ON a.id = pl.atelier_id AND pl.creneau_id = ?
            JOIN creneaux cr ON pl.creneau_id = cr.id
            JOIN salles s ON pl.salle_id = s.id
            LEFT JOIN utilisateurs u ON u.acronyme IN (a.enseignant_acronyme, a.enseignant2_acronyme, a.enseignant3_acronyme)
            WHERE a.id = ?
            GROUP BY a.id, cr.id, s.id
        `, [creneauId, atelierId]);
        
        if (atelierInfo.length === 0) {
            return res.status(404).json({ success: false, message: 'Atelier non trouvé pour ce créneau' });
        }
        
        const info = atelierInfo[0];
        
        // Liste élèves
        const eleves = await query(`
            SELECT 
                u.nom,
                u.prenom,
                c.nom as classe
            FROM inscriptions i
            JOIN eleves e ON i.eleve_id = e.id
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes c ON e.classe_id = c.id
            WHERE i.atelier_id = ?
            ORDER BY c.nom, u.nom, u.prenom
        `, [atelierId]);
        
        // Générer HTML
        const jourCap = info.jour.charAt(0).toUpperCase() + info.jour.slice(1);
        let html = generateHtmlHeader('📋 Liste de Présence', info.nom);
        
        html += `
        <div class="info-box">
            <p><strong>Créneau :</strong> ${jourCap} ${info.periode}</p>
            <p><strong>Salle :</strong> ${info.salle_nom}</p>
            <p><strong>Enseignant(s) :</strong> ${info.enseignants || '-'}</p>
            <p><strong>Effectif :</strong> ${eleves.length} élèves</p>
        </div>
        
        <table>
            <thead>
                <tr>
                    <th style="width: 40px;">✓</th>
                    <th>Nom</th>
                    <th>Prénom</th>
                    <th style="width: 80px;">Classe</th>
                    <th style="width: 150px;">Remarque</th>
                </tr>
            </thead>
            <tbody>
        `;
        
        eleves.forEach((e, i) => {
            html += `
                <tr>
                    <td style="text-align: center;"><div class="checkbox"></div></td>
                    <td>${e.nom}</td>
                    <td>${e.prenom}</td>
                    <td>${e.classe}</td>
                    <td></td>
                </tr>
            `;
        });
        
        html += `
            </tbody>
        </table>
        
        <div style="margin-top: 30px;">
            <p><strong>Présents :</strong> _____ / ${eleves.length}</p>
            <p style="margin-top: 10px;"><strong>Absents :</strong> _____</p>
            <p style="margin-top: 20px;"><strong>Signature enseignant :</strong> ______________________</p>
        </div>
        `;
        
        html += generateHtmlFooter();
        
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
        
    } catch (error) {
        console.error('Erreur génération liste présence:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ============================================================
// HORAIRES ÉLÈVES
// ============================================================

/**
 * GET /api/print/horaire/eleve/:eleveId
 * PDF horaire d'un élève
 */
router.get('/horaire/eleve/:eleveId', async (req, res) => {
    try {
        const { eleveId } = req.params;
        
        // Infos élève
        const eleveInfo = await query(`
            SELECT u.nom, u.prenom, c.nom as classe
            FROM eleves e
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes c ON e.classe_id = c.id
            WHERE e.id = ?
        `, [eleveId]);
        
        if (eleveInfo.length === 0) {
            return res.status(404).json({ success: false, message: 'Élève non trouvé' });
        }
        
        const eleve = eleveInfo[0];
        
        // Planning élève
        const planning = await query(`
            SELECT 
                cr.jour,
                cr.periode,
                cr.ordre,
                a.nom as atelier_nom,
                s.nom as salle_nom,
                GROUP_CONCAT(DISTINCT 
                    CASE 
                        WHEN u.acronyme = a.enseignant_acronyme THEN CONCAT(u.prenom, ' ', u.nom)
                        WHEN u.acronyme = a.enseignant2_acronyme THEN CONCAT(u.prenom, ' ', u.nom)
                        WHEN u.acronyme = a.enseignant3_acronyme THEN CONCAT(u.prenom, ' ', u.nom)
                    END
                    SEPARATOR ', '
                ) as enseignants
            FROM inscriptions i
            JOIN ateliers a ON i.atelier_id = a.id
            JOIN planning pl ON a.id = pl.atelier_id
            JOIN creneaux cr ON pl.creneau_id = cr.id
            JOIN salles s ON pl.salle_id = s.id
            LEFT JOIN utilisateurs u ON u.acronyme IN (a.enseignant_acronyme, a.enseignant2_acronyme, a.enseignant3_acronyme)
            WHERE i.eleve_id = ? AND a.statut = 'valide'
            GROUP BY cr.id, a.id, s.id
            ORDER BY cr.ordre
        `, [eleveId]);
        
        // Générer HTML
        let html = generateHtmlHeader('📅 Horaire Semaine Spéciale', `${eleve.prenom} ${eleve.nom} (${eleve.classe})`);
        
        html += `
        <table>
            <thead>
                <tr>
                    <th style="width: 120px;">Créneau</th>
                    <th>Atelier</th>
                    <th style="width: 80px;">Salle</th>
                    <th>Enseignant(s)</th>
                </tr>
            </thead>
            <tbody>
        `;
        
        if (planning.length === 0) {
            html += `<tr><td colspan="4" style="text-align: center; color: #666;">Aucune inscription</td></tr>`;
        } else {
            planning.forEach(p => {
                const jourCap = p.jour.charAt(0).toUpperCase() + p.jour.slice(1);
                html += `
                    <tr>
                        <td><strong>${jourCap}</strong><br>${p.periode}</td>
                        <td>${p.atelier_nom}</td>
                        <td>${p.salle_nom}</td>
                        <td>${p.enseignants || '-'}</td>
                    </tr>
                `;
            });
        }
        
        html += `
            </tbody>
        </table>
        `;
        
        html += generateHtmlFooter();
        
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
        
    } catch (error) {
        console.error('Erreur génération horaire élève:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/print/horaires/eleves
 * PDF horaires de tous les élèves (multi-pages)
 */
router.get('/horaires/eleves', async (req, res) => {
    try {
        const { classe } = req.query; // Filtre optionnel par classe
        
        // Liste des élèves
        let sql = `
            SELECT e.id, u.nom, u.prenom, c.nom as classe
            FROM eleves e
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes c ON e.classe_id = c.id
        `;
        const params = [];
        
        if (classe) {
            sql += ' WHERE c.nom = ?';
            params.push(classe);
        }
        
        sql += ' ORDER BY c.nom, u.nom, u.prenom';
        
        const eleves = await query(sql, params);
        
        // Générer HTML multi-pages
        let html = generateHtmlHeader('📅 Horaires Semaine Spéciale', classe ? `Classe ${classe}` : 'Tous les élèves');
        
        html += `<p style="margin-bottom: 20px;">Total : ${eleves.length} élèves</p>`;
        
        for (let i = 0; i < eleves.length; i++) {
            const eleve = eleves[i];
            
            if (i > 0) {
                html += '<div class="page-break"></div>';
            }
            
            // Planning de cet élève
            const planning = await query(`
                SELECT 
                    cr.jour,
                    cr.periode,
                    cr.ordre,
                    a.nom as atelier_nom,
                    s.nom as salle_nom,
                    CONCAT_WS(', ',
                        (SELECT CONCAT(prenom, ' ', nom) FROM utilisateurs WHERE acronyme = a.enseignant_acronyme),
                        (SELECT CONCAT(prenom, ' ', nom) FROM utilisateurs WHERE acronyme = a.enseignant2_acronyme),
                        (SELECT CONCAT(prenom, ' ', nom) FROM utilisateurs WHERE acronyme = a.enseignant3_acronyme)
                    ) as enseignants
                FROM inscriptions i
                JOIN ateliers a ON i.atelier_id = a.id
                JOIN planning pl ON a.id = pl.atelier_id
                JOIN creneaux cr ON pl.creneau_id = cr.id
                JOIN salles s ON pl.salle_id = s.id
                WHERE i.eleve_id = ? AND a.statut = 'valide'
                ORDER BY cr.ordre
            `, [eleve.id]);
            
            html += `
            <div style="margin-bottom: 10px; padding: 10px; background: #667eea; color: white; border-radius: 5px;">
                <strong>${eleve.prenom} ${eleve.nom}</strong> - ${eleve.classe}
            </div>
            
            <table>
                <thead>
                    <tr>
                        <th style="width: 120px;">Créneau</th>
                        <th>Atelier</th>
                        <th style="width: 80px;">Salle</th>
                        <th>Enseignant(s)</th>
                    </tr>
                </thead>
                <tbody>
            `;
            
            if (planning.length === 0) {
                html += `<tr><td colspan="4" style="text-align: center; color: #666;">Aucune inscription</td></tr>`;
            } else {
                planning.forEach(p => {
                    const jourCap = p.jour.charAt(0).toUpperCase() + p.jour.slice(1);
                    html += `
                        <tr>
                            <td><strong>${jourCap}</strong><br>${p.periode}</td>
                            <td>${p.atelier_nom}</td>
                            <td>${p.salle_nom}</td>
                            <td>${p.enseignants || '-'}</td>
                        </tr>
                    `;
                });
            }
            
            html += '</tbody></table>';
        }
        
        html += generateHtmlFooter();
        
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
        
    } catch (error) {
        console.error('Erreur génération horaires élèves:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ============================================================
// HORAIRES ENSEIGNANTS
// ============================================================

/**
 * GET /api/print/horaire/enseignant/:acronyme
 * PDF horaire d'un enseignant
 */
router.get('/horaire/enseignant/:acronyme', async (req, res) => {
    try {
        const { acronyme } = req.params;
        const user = req.user;
        
        // Vérifier accès (admin ou soi-même)
        if (user.role !== 'admin' && user.acronyme !== acronyme) {
            return res.status(403).json({ success: false, message: 'Accès non autorisé' });
        }
        
        // Infos enseignant
        const ensInfo = await query(`
            SELECT acronyme, nom, prenom
            FROM utilisateurs
            WHERE acronyme = ? AND role = 'enseignant'
        `, [acronyme]);
        
        if (ensInfo.length === 0) {
            return res.status(404).json({ success: false, message: 'Enseignant non trouvé' });
        }
        
        const ens = ensInfo[0];
        
        // Planning enseignant (ateliers)
        const ateliers = await query(`
            SELECT 
                cr.jour,
                cr.periode,
                cr.ordre,
                a.nom as atelier_nom,
                s.nom as salle_nom,
                (SELECT COUNT(*) FROM inscriptions WHERE atelier_id = a.id) as nb_inscrits,
                'atelier' as type
            FROM ateliers a
            JOIN planning pl ON a.id = pl.atelier_id
            JOIN creneaux cr ON pl.creneau_id = cr.id
            JOIN salles s ON pl.salle_id = s.id
            WHERE a.statut = 'valide'
            AND (a.enseignant_acronyme = ? OR a.enseignant2_acronyme = ? OR a.enseignant3_acronyme = ?)
            ORDER BY cr.ordre
        `, [acronyme, acronyme, acronyme]);
        
        // Piquets
        const piquets = await query(`
            SELECT 
                cr.jour,
                cr.periode,
                cr.ordre,
                ep.type,
                'piquet' as category
            FROM enseignants_piquet ep
            JOIN creneaux cr ON ep.creneau_id = cr.id
            JOIN utilisateurs u ON ep.utilisateur_id = u.id
            WHERE u.acronyme = ?
            ORDER BY cr.ordre
        `, [acronyme]);
        
        // Fusionner et trier
        const planning = [...ateliers, ...piquets.map(p => ({
            ...p,
            atelier_nom: p.type === 'piquet' ? '🟡 PIQUET' : '🟢 DÉGAGEMENT',
            salle_nom: '-',
            nb_inscrits: '-'
        }))].sort((a, b) => a.ordre - b.ordre);
        
        // Générer HTML
        let html = generateHtmlHeader('📅 Horaire Semaine Spéciale', `${ens.prenom} ${ens.nom} (${ens.acronyme})`);
        
        html += `
        <table>
            <thead>
                <tr>
                    <th style="width: 120px;">Créneau</th>
                    <th>Atelier / Activité</th>
                    <th style="width: 80px;">Salle</th>
                    <th style="width: 80px;">Inscrits</th>
                </tr>
            </thead>
            <tbody>
        `;
        
        if (planning.length === 0) {
            html += `<tr><td colspan="4" style="text-align: center; color: #666;">Aucun atelier ou piquet assigné</td></tr>`;
        } else {
            planning.forEach(p => {
                const jourCap = p.jour.charAt(0).toUpperCase() + p.jour.slice(1);
                const isPiquet = p.atelier_nom.includes('PIQUET') || p.atelier_nom.includes('DÉGAGEMENT');
                const style = isPiquet ? 'background: #fef3c7;' : '';
                html += `
                    <tr style="${style}">
                        <td><strong>${jourCap}</strong><br>${p.periode}</td>
                        <td>${p.atelier_nom}</td>
                        <td>${p.salle_nom}</td>
                        <td style="text-align: center;">${p.nb_inscrits}</td>
                    </tr>
                `;
            });
        }
        
        html += '</tbody></table>';
        html += generateHtmlFooter();
        
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
        
    } catch (error) {
        console.error('Erreur génération horaire enseignant:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

/**
 * GET /api/print/horaires/enseignants
 * PDF horaires de tous les enseignants (multi-pages)
 */
router.get('/horaires/enseignants', async (req, res) => {
    try {
        // Liste des enseignants
        const enseignants = await query(`
            SELECT acronyme, nom, prenom
            FROM utilisateurs
            WHERE role = 'enseignant' AND actif = TRUE
            ORDER BY nom, prenom
        `);
        
        // Générer HTML multi-pages
        let html = generateHtmlHeader('📅 Horaires Enseignants', 'Semaine Spéciale');
        
        html += `<p style="margin-bottom: 20px;">Total : ${enseignants.length} enseignants</p>`;
        
        for (let i = 0; i < enseignants.length; i++) {
            const ens = enseignants[i];
            
            if (i > 0) {
                html += '<div class="page-break"></div>';
            }
            
            // Planning de cet enseignant
            const ateliers = await query(`
                SELECT 
                    cr.jour,
                    cr.periode,
                    cr.ordre,
                    a.nom as atelier_nom,
                    s.nom as salle_nom,
                    (SELECT COUNT(*) FROM inscriptions WHERE atelier_id = a.id) as nb_inscrits
                FROM ateliers a
                JOIN planning pl ON a.id = pl.atelier_id
                JOIN creneaux cr ON pl.creneau_id = cr.id
                JOIN salles s ON pl.salle_id = s.id
                WHERE a.statut = 'valide'
                AND (a.enseignant_acronyme = ? OR a.enseignant2_acronyme = ? OR a.enseignant3_acronyme = ?)
                ORDER BY cr.ordre
            `, [ens.acronyme, ens.acronyme, ens.acronyme]);
            
            const piquets = await query(`
                SELECT 
                    cr.jour,
                    cr.periode,
                    cr.ordre,
                    ep.type
                FROM enseignants_piquet ep
                JOIN creneaux cr ON ep.creneau_id = cr.id
                JOIN utilisateurs u ON ep.utilisateur_id = u.id
                WHERE u.acronyme = ?
            `, [ens.acronyme]);
            
            html += `
            <div style="margin-bottom: 10px; padding: 10px; background: #667eea; color: white; border-radius: 5px;">
                <strong>${ens.prenom} ${ens.nom}</strong> (${ens.acronyme})
            </div>
            
            <table>
                <thead>
                    <tr>
                        <th style="width: 120px;">Créneau</th>
                        <th>Atelier / Activité</th>
                        <th style="width: 80px;">Salle</th>
                        <th style="width: 80px;">Inscrits</th>
                    </tr>
                </thead>
                <tbody>
            `;
            
            const planning = [...ateliers, ...piquets.map(p => ({
                ...p,
                atelier_nom: p.type === 'piquet' ? '🟡 PIQUET' : '🟢 DÉGAGEMENT',
                salle_nom: '-',
                nb_inscrits: '-'
            }))].sort((a, b) => a.ordre - b.ordre);
            
            if (planning.length === 0) {
                html += `<tr><td colspan="4" style="text-align: center; color: #666;">Aucune activité</td></tr>`;
            } else {
                planning.forEach(p => {
                    const jourCap = p.jour.charAt(0).toUpperCase() + p.jour.slice(1);
                    const isPiquet = p.atelier_nom.includes('PIQUET') || p.atelier_nom.includes('DÉGAGEMENT');
                    const style = isPiquet ? 'background: #fef3c7;' : '';
                    html += `
                        <tr style="${style}">
                            <td><strong>${jourCap}</strong><br>${p.periode}</td>
                            <td>${p.atelier_nom}</td>
                            <td>${p.salle_nom}</td>
                            <td style="text-align: center;">${p.nb_inscrits}</td>
                        </tr>
                    `;
                });
            }
            
            html += '</tbody></table>';
        }
        
        html += generateHtmlFooter();
        
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
        
    } catch (error) {
        console.error('Erreur génération horaires enseignants:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// ============================================================
// RAPPORT ABSENCES
// ============================================================

/**
 * GET /api/print/absences
 * PDF rapport des absences (filtrable)
 */
router.get('/absences', async (req, res) => {
    try {
        const { creneau_id, jour } = req.query;
        
        let sql = `
            SELECT 
                cr.jour,
                cr.periode,
                cr.ordre,
                a.nom as atelier_nom,
                u.nom as eleve_nom,
                u.prenom as eleve_prenom,
                c.nom as classe_nom,
                p.commentaire
            FROM presences p
            JOIN ateliers a ON p.atelier_id = a.id
            JOIN eleves e ON p.eleve_id = e.id
            JOIN utilisateurs u ON e.utilisateur_id = u.id
            JOIN classes c ON e.classe_id = c.id
            JOIN creneaux cr ON p.creneau_id = cr.id
            WHERE p.statut = 'absent'
        `;
        
        const params = [];
        let subtitle = 'Tous les créneaux';
        
        if (creneau_id) {
            sql += ' AND cr.id = ?';
            params.push(creneau_id);
        }
        
        if (jour) {
            sql += ' AND cr.jour = ?';
            params.push(jour);
            subtitle = `${jour.charAt(0).toUpperCase() + jour.slice(1)}`;
        }
        
        sql += ' ORDER BY cr.ordre, c.nom, u.nom';
        
        const absences = await query(sql, params);
        
        // Générer HTML
        let html = generateHtmlHeader('🔴 Rapport des Absences', subtitle);
        
        // Stats par créneau
        const statsCreneau = {};
        absences.forEach(a => {
            const key = `${a.jour} ${a.periode}`;
            statsCreneau[key] = (statsCreneau[key] || 0) + 1;
        });
        
        html += `
        <div class="stats" style="flex-wrap: wrap;">
            <div class="stat-box">
                <div class="stat-value">${absences.length}</div>
                <div class="stat-label">Total absents</div>
            </div>
        `;
        
        Object.entries(statsCreneau).forEach(([creneau, count]) => {
            html += `
            <div class="stat-box">
                <div class="stat-value">${count}</div>
                <div class="stat-label">${creneau}</div>
            </div>
            `;
        });
        
        html += '</div>';
        
        html += `
        <table>
            <thead>
                <tr>
                    <th style="width: 120px;">Créneau</th>
                    <th>Atelier</th>
                    <th>Élève</th>
                    <th style="width: 80px;">Classe</th>
                    <th style="width: 120px;">Remarque</th>
                </tr>
            </thead>
            <tbody>
        `;
        
        if (absences.length === 0) {
            html += `<tr><td colspan="5" style="text-align: center; color: #10b981;">✅ Aucune absence signalée</td></tr>`;
        } else {
            absences.forEach(a => {
                const jourCap = a.jour.charAt(0).toUpperCase() + a.jour.slice(1);
                html += `
                    <tr>
                        <td><strong>${jourCap}</strong><br>${a.periode}</td>
                        <td>${a.atelier_nom}</td>
                        <td class="absent">${a.eleve_nom} ${a.eleve_prenom}</td>
                        <td>${a.classe_nom}</td>
                        <td>${a.commentaire || '-'}</td>
                    </tr>
                `;
            });
        }
        
        html += '</tbody></table>';
        html += generateHtmlFooter();
        
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
        
    } catch (error) {
        console.error('Erreur génération rapport absences:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

module.exports = router;
