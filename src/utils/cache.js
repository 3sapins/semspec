/**
 * Cache simple en mémoire pour données statiques
 * Réduit les requêtes répétitives
 */

class SimpleCache {
    constructor() {
        this.cache = new Map();
        this.ttl = new Map(); // Time to live
    }

    /**
     * Récupérer une valeur du cache
     */
    get(key) {
        if (!this.cache.has(key)) return null;
        
        const expiry = this.ttl.get(key);
        if (expiry && Date.now() > expiry) {
            this.cache.delete(key);
            this.ttl.delete(key);
            return null;
        }
        
        return this.cache.get(key);
    }

    /**
     * Stocker une valeur
     * @param {string} key 
     * @param {any} value 
     * @param {number} ttlSeconds - Durée de vie en secondes (défaut: 5 min)
     */
    set(key, value, ttlSeconds = 300) {
        this.cache.set(key, value);
        this.ttl.set(key, Date.now() + (ttlSeconds * 1000));
    }

    /**
     * Invalider une clé ou un pattern
     */
    invalidate(keyOrPattern) {
        if (keyOrPattern.includes('*')) {
            const pattern = keyOrPattern.replace('*', '');
            for (const key of this.cache.keys()) {
                if (key.startsWith(pattern)) {
                    this.cache.delete(key);
                    this.ttl.delete(key);
                }
            }
        } else {
            this.cache.delete(keyOrPattern);
            this.ttl.delete(keyOrPattern);
        }
    }

    /**
     * Vider tout le cache
     */
    clear() {
        this.cache.clear();
        this.ttl.clear();
    }

    /**
     * Stats du cache
     */
    stats() {
        return {
            size: this.cache.size,
            keys: Array.from(this.cache.keys())
        };
    }
}

// Instance globale
const cache = new SimpleCache();

/**
 * Wrapper pour requêtes avec cache
 * @param {string} cacheKey 
 * @param {Function} queryFn - Fonction async qui fait la requête
 * @param {number} ttl - Durée cache en secondes
 */
async function cachedQuery(cacheKey, queryFn, ttl = 300) {
    const cached = cache.get(cacheKey);
    if (cached) {
        return cached;
    }
    
    const result = await queryFn();
    cache.set(cacheKey, result, ttl);
    return result;
}

module.exports = { cache, cachedQuery };
