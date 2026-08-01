import jwt from "jsonwebtoken";
import MatchMaker, { Region } from "../../services/MatchMaker";
import logger from "../../utils/logger";
import { Socket } from "socket.io";
import { DefaultEventsMap } from "socket.io";
import { config } from "../../config/config";

interface GameTokenPayload {
  sub: string;
  username: string;
}

// socket.id / playerMatchId are the existing match-scoped reconnect identity and are left
// untouched. This only resolves a *display name* override for logged-in players — a missing,
// invalid, or expired token is NOT an error, it just means play as a guest under the
// client-supplied name, exactly as before this existed. A bad token carries no less trust than a
// guest already had, so we never disconnect on one.
function resolvePlayerName(socket: Socket, guestName: string): string {
  const token = socket.handshake.auth?.token;
  if (!token || !config.GAME_TOKEN_VERIFICATION_ENABLED) {
    return guestName;
  }

  try {
    const payload = jwt.verify(token, config.GAME_TOKEN_SECRET, {
      algorithms: ["HS256"],
      audience: "game-server",
    }) as GameTokenPayload;
    return payload.username;
  } catch (err) {
    logger.warn(`Invalid/expired game-token for socket ${socket.id}; falling back to guest name`);
    return guestName;
  }
}

export default function connectionHandler(
  socket: Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>,
  io: any
) {

  // TODO: Fix issue where players are not able to reconnect and instead join as new players.
  // likely caused by bug in player id logic
  logger.info(`Socket connected: ${socket.id}`);
    // Get and log the total number of connected clients
  const connectedClients = io.engine.clientsCount;
  logger.info(`Total connected clients connected: ${connectedClients}`);
  socket.on('joinQueue', ({ region, name, playerMatchId }: { region: string, name: string, playerMatchId: string}) => {
      logger.info(`Socket ${socket.id} emitted joinQueue`);
      if (config.VALID_REGIONS.includes(region)) {
        logger.info(`Valid region: ${region}, queuing player`);
        MatchMaker.enqueuePlayer({
          id: socket.id,
          playerMatchId,
          name: resolvePlayerName(socket, name),
          socket,
          region: region as Region,
          enqueuedAt: Date.now()
        }, io);
      } else {
        socket.emit('error', { message: 'Invalid region' });
        socket.disconnect(true);
      }
  });


  socket.on('disconnect', (reason) => {
      logger.info(`Socket disconnected: ${socket.id}, reason: ${reason}`);
  });

}