const mysql = require('mysql2/promise');

// Pool de connexions MySQL/MariaDB
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'semaine_user',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'semaine_speciale',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
});

// Fonction query simplifiée
async function query(sql, params = []) {
    const [rows] = await pool.execute(sql, params);
    return rows;
}

// Fonction transaction
async function transaction(callback) {
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    
    try {
        const result = await callback(connection);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

// Test de connexion
async function testConnection() {
    try {
        const connection = await pool.getConnection();
        console.log('✅ Connexion à la base de données réussie');
        connection.release();
        return true;
    } catch (error) {
        console.error('❌ Erreur de connexion à la base de données:', error.message);
        return false;
    }
}

module.exports = { pool, query, transaction, testConnection };
