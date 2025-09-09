import MatchMaker, { Region } from "../../services/MatchMaker";
import logger from "../../utils/logger";
import { Socket } from "socket.io";
import { DefaultEventsMap } from "socket.io";
import { config } from "../../config/config";

export default function connectionHandler(socket: Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>) {
  logger.info(`Socket connected: ${socket.id}`);
  socket.on('joinQueue', ({ region, name }: { region: string, name: string}) => {
      logger.info(`Socket ${socket.id} emitted joinQueue`);
      if (config.VALID_REGIONS.includes(region)) {
        logger.info(`Valid region: ${region}, queuing player`);
        MatchMaker.enqueuePlayer({
          id: socket.handshake.auth.uuid,
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
}