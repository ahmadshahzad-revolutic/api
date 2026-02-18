import session from 'express-session';
import MongoStore from 'connect-mongo';
import { MONGO_URI } from './env';

export const sessionConfig = session({
    secret: 'revolutic-session-secret',
    resave: false,
    saveUninitialized: false,
    // proxy: true,
    store: MongoStore.create({
        mongoUrl: MONGO_URI,
        collectionName: 'sessions'
    }),
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
        secure: false, // Set to false for local HTTP
        sameSite: 'lax',
        httpOnly: true
    }
});
