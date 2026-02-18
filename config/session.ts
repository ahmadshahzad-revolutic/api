import session from 'express-session';
import MongoStore from 'connect-mongo';
import { MONGO_URI } from './env';

export const sessionConfig = session({
    secret: 'revolutic-session-secret',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: MONGO_URI,
        collectionName: 'sessions'
    }),
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 7,
        secure: false,
        sameSite: 'lax',
        httpOnly: true
    }
});
