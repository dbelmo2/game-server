export const config = {
    CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:3000',
    MAX_PLAYERS_PER_MATCH: parseInt(process.env.MAX_PLAYERS_PER_MATCH || '10', 10),
    PORT: parseInt(process.env.PORT || '3000', 10),
    NODE_ENV: process.env.NODE_ENV || 'development',
}
