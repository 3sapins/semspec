const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { testConnection, query } = require('./config/database');
const bcrypt = require('bcrypt');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const enseignantsRoutes = require('./routes/enseignants');
const planningRoutes = require('./routes/planning');
const elevesRoutes = require('./routes/eleves');
const gestionRoutes = require('./routes/gestion');
const presenceRoutes = require('./routes/presence');
const printRoutes = require('./routes/print');
const catalogueRoutes = require('./routes/catalogue');
const evaluationsRoutes = require('./routes/evaluations');
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir les fichiers statiques (interface web)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Dossier uploads
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Routes API
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/enseignants', enseignantsRoutes);
app.use('/api/planning', planningRoutes);
app.use('/api/eleves', elevesRoutes);
app.use('/api/gestion', gestionRoutes);
app.use('/api/presence', presenceRoutes);
app.use('/api/print', printRoutes);
app.use('/api/evaluations', evaluationsRoutes);
app.use('/api/catalogue', catalogueRoutes);

// Route de test
app.get('/api/health', (req, res) => {
    res.json({ 
        success: true, 
        message: 'Serveur opérationnel',
        timestamp: new Date().toISOString()
    });
});

// Route par défaut - redirection vers login
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// Gestion des erreurs 404
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route non trouvée'
    });
});

// Gestion globale des erreurs
app.use((err, req, res, next) => {
    console.error('Erreur serveur:', err);
    res.status(500).json({
        success: false,
        message: 'Erreur serveur interne',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Initialisation du compte admin
async function initAdmin() {
    try {
        const admins = await query("SELECT id FROM utilisateurs WHERE acronyme = 'admin'");
        
        if (admins.length === 0) {
            const hash = await bcrypt.hash('SemaineSpeciale2026!', 10);
            await query(
                "INSERT INTO utilisateurs (acronyme, nom, prenom, email, mot_de_passe, role, actif) VALUES (?, ?, ?, ?, ?, ?, TRUE)",
                ['admin', 'Administrateur', 'Système', 'admin@trois-sapins.ch', hash, 'admin']
            );
            console.log('✅ Compte admin créé (mot de passe: SemaineSpeciale2026!)');
        }
    } catch (error) {
        console.error('⚠️ Erreur init admin:', error.message);
    }
}

// Démarrage du serveur
async function startServer() {
    try {
        const dbConnected = await testConnection();
        
        if (!dbConnected) {
            console.error('❌ Impossible de démarrer sans connexion à la base de données');
            console.error('Vérifiez votre fichier .env et votre installation MySQL');
            process.exit(1);
        }

        await initAdmin();

        app.listen(PORT, () => {
            console.log('\n╔════════════════════════════════════════════════════════════╗');
            console.log('║   🎓 PLATEFORME SEMAINE SPÉCIALE - COLLÈGE TROIS-SAPINS   ║');
            console.log('╚════════════════════════════════════════════════════════════╝\n');
            console.log(`🚀 Serveur démarré sur le port ${PORT}`);
            console.log(`🌐 Interface web: http://localhost:${PORT}`);
            console.log(`📡 API disponible: http://localhost:${PORT}/api`);
            console.log(`\n👤 Connexion admin: admin / SemaineSpeciale2026!\n`);
        });

    } catch (error) {
        console.error('❌ Erreur au démarrage:', error);
        process.exit(1);
    }
}

process.on('SIGTERM', () => {
    console.log('\n👋 Arrêt du serveur...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\n👋 Arrêt du serveur...');
    process.exit(0);
});

startServer();

module.exports = app;
