export const config = {
    CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:5174',
    MAX_PLAYERS_PER_MATCH: parseInt(process.env.MAX_PLAYERS_PER_MATCH || '10', 10),
    PORT: parseInt(process.env.PORT || '3001', 10),
    NODE_ENV: process.env.NODE_ENV || 'development',
    VALID_REGIONS: process.env.VALID_REGIONS ? process.env.VALID_REGIONS.split(',') : ['NA', 'EU', 'ASIA'],
}
