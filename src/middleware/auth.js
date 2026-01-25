const jwt = require('jsonwebtoken');
require('dotenv').config();

// Middleware pour vérifier le token JWT
const authMiddleware = (req, res, next) => {
    try {
        // Récupération du token depuis le header Authorization
        const authHeader = req.headers.authorization;
        
        if (!authHeader) {
            return res.status(401).json({ 
                success: false, 
                message: 'Token d\'authentification manquant' 
            });
        }

        // Format attendu: "Bearer TOKEN"
        const token = authHeader.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ 
                success: false, 
                message: 'Format de token invalide' 
            });
        }

        // Vérification du token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Ajout des informations utilisateur à la requête
        req.user = {
            id: decoded.id,
            acronyme: decoded.acronyme,
            role: decoded.role,
            nom: decoded.nom,
            prenom: decoded.prenom
        };
        
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ 
                success: false, 
                message: 'Token expiré' 
            });
        }
        
        return res.status(401).json({ 
            success: false, 
            message: 'Token invalide' 
        });
    }
};

// Middleware pour vérifier le rôle admin
const adminMiddleware = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ 
            success: false, 
            message: 'Accès refusé - Droits administrateur requis' 
        });
    }
    next();
};

// Middleware pour vérifier le rôle enseignant
const enseignantMiddleware = (req, res, next) => {
    if (req.user.role !== 'enseignant' && req.user.role !== 'admin') {
        return res.status(403).json({ 
            success: false, 
            message: 'Accès refusé - Droits enseignant requis' 
        });
    }
    next();
};

// Middleware pour vérifier le rôle élève
const eleveMiddleware = (req, res, next) => {
    if (req.user.role !== 'eleve' && req.user.role !== 'admin') {
        return res.status(403).json({ 
            success: false, 
            message: 'Accès refusé - Droits élève requis' 
        });
    }
    next();
};

// Fonction pour générer un token JWT
const generateToken = (user) => {
    return jwt.sign(
        {
            id: user.id,
            acronyme: user.acronyme,
            role: user.role,
            nom: user.nom,
            prenom: user.prenom
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );
};

module.exports = {
    authMiddleware,
    adminMiddleware,
    enseignantMiddleware,
    eleveMiddleware,
    generateToken
};
