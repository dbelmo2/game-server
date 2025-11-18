import MatchMaker, { Region } from "../../services/MatchMaker";
import logger from "../../utils/logger";
import { Socket } from "socket.io";
import { DefaultEventsMap } from "socket.io";
import { config } from "../../config/config";

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
          name,
          socket,
          region: region as Region,
          enqueuedAt: Date.now()
        });
      } else {
        socket.emit('error', { message: 'Invalid region' });
        socket.disconnect(true);
      }
  });


  socket.on('disconnect', (reason) => {
      logger.info(`Socket disconnected: ${socket.id}, reason: ${reason}`);
  });

}