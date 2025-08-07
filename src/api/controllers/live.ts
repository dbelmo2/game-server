import matchMaker from "../../services/MatchMaker";
import { Request, Response } from "express";

export const handleShowIsLive = (_req: Request, res: Response) => {
    matchMaker.setShowIsLive(true);
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString()
    });
};
