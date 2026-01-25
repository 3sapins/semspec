const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { query } = require('../config/database');
const { generateToken, authMiddleware } = require('../middleware/auth');

/**
 * POST /api/auth/login
 * Connexion d'un utilisateur (admin, enseignant, élève)
 */
router.post('/login', async (req, res) => {
    try {
        const { identifiant, mot_de_passe, acronyme, password } = req.body;
        
        // Support des deux formats
        const user_id = identifiant || acronyme;
        const user_pass = mot_de_passe || password;

        // Validation des données
        if (!user_id || !user_pass) {
            return res.status(400).json({
                success: false,
                message: 'Identifiant et mot de passe requis'
            });
        }

        // Recherche de l'utilisateur (case insensitive pour l'acronyme)
        const users = await query(
            'SELECT * FROM utilisateurs WHERE (UPPER(acronyme) = UPPER(?) OR LOWER(acronyme) = LOWER(?)) AND actif = TRUE',
            [user_id, user_id]
        );

        if (users.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Identifiants incorrects'
            });
        }

        const user = users[0];

        // Vérification du mot de passe
        const passwordMatch = await bcrypt.compare(user_pass, user.mot_de_passe);

        if (!passwordMatch) {
            return res.status(401).json({
                success: false,
                message: 'Identifiants incorrects'
            });
        }

        // Mise à jour de la dernière connexion
        await query(
            'UPDATE utilisateurs SET derniere_connexion = NOW() WHERE id = ?',
            [user.id]
        );

        // Génération du token JWT
        const token = generateToken(user);

        // Log de l'action
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [user.id, 'LOGIN', `Connexion réussie pour ${user.acronyme}`]
        );

        res.json({
            success: true,
            message: 'Connexion réussie',
            data: {
                token,
                user: {
                    id: user.id,
                    acronyme: user.acronyme,
                    nom: user.nom,
                    prenom: user.prenom,
                    email: user.email,
                    role: user.role
                }
            }
        });

    } catch (error) {
        console.error('Erreur lors de la connexion:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur serveur lors de la connexion'
        });
    }
});

/**
 * POST /api/auth/change-password
 * Changement de mot de passe (utilisateur connecté)
 */
router.post('/change-password', authMiddleware, async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        const userId = req.user.id;

        // Validation
        if (!oldPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Ancien et nouveau mot de passe requis'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Le nouveau mot de passe doit contenir au moins 6 caractères'
            });
        }

        // Récupération de l'utilisateur
        const users = await query('SELECT * FROM utilisateurs WHERE id = ?', [userId]);
        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Utilisateur non trouvé'
            });
        }

        const user = users[0];

        // Vérification de l'ancien mot de passe
        const passwordMatch = await bcrypt.compare(oldPassword, user.mot_de_passe);
        if (!passwordMatch) {
            return res.status(401).json({
                success: false,
                message: 'Ancien mot de passe incorrect'
            });
        }

        // Hashage du nouveau mot de passe
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Mise à jour
        await query(
            'UPDATE utilisateurs SET mot_de_passe = ? WHERE id = ?',
            [hashedPassword, userId]
        );

        // Log
        await query(
            'INSERT INTO historique (utilisateur_id, action, details) VALUES (?, ?, ?)',
            [userId, 'CHANGE_PASSWORD', 'Changement de mot de passe']
        );

        res.json({
            success: true,
            message: 'Mot de passe modifié avec succès'
        });

    } catch (error) {
        console.error('Erreur changement mot de passe:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors du changement de mot de passe'
        });
    }
});

module.exports = router;
