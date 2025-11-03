import MatchMaker, { Region } from "../../services/MatchMaker";
import logger from "../../utils/logger";
import { Socket } from "socket.io";
import { DefaultEventsMap } from "socket.io";
import { config } from "../../config/config";

export default function connectionHandler(
  socket: Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>, 
  io: any
) {
  logger.info(`Socket connected: ${socket.id}`);
    // Get and log the total number of connected clients
  const connectedClients = io.engine.clientsCount;
  console.log(`Total connected clients connected: ${connectedClients}`);
  socket.on('joinQueue', ({ region, name }: { region: string, name: string}) => {
      logger.info(`Socket ${socket.id} emitted joinQueue`);
      if (config.VALID_REGIONS.includes(region)) {
        logger.info(`Valid region: ${region}, queuing player`);
        MatchMaker.enqueuePlayer({
          id: socket.id,
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