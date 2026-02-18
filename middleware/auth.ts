import { Request, Response, NextFunction } from 'express';

export interface AuthRequest extends Request {
    user?: {
        id: string;
    };
}

export const auth = (req: AuthRequest, res: Response, next: NextFunction) => {
    // Check session
    if (!req.session || !(req.session as any).user) {
        return res.status(401).json({ message: 'No session, authorization denied' });
    }

    req.user = (req.session as any).user;
    next();
};
