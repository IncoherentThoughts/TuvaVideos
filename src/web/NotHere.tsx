// Now playing for a Video that is Not on this machine (sharing-spec §7.1): where the Player would be, a panel over the
// blurred poster with the message and the Video's source link. Play.tsx swaps it for the Player as soon as its poll sees
// a Copy (a scan found the file), the way the unmounted overlay gives way today.
import type { VideoDto } from "../shared/types";
import { NOT_HERE_MESSAGE, sourceLink } from "../shared/presence";

export function NotHerePanel({ video }: { video: VideoDto }) {
  const link = sourceLink(video);
  return (
    <div class="nothere-panel" role="status" data-nothere="">
      {video.thumbnail && <img class="bg" src={video.thumbnail.poster} alt="" />}
      <div class="box">
        <h3>Not on this machine</h3>
        <p>{NOT_HERE_MESSAGE}</p>
        {link ? (
          <p>
            {link.site}:{" "}
            <a href={link.href} target="_blank" rel="noopener noreferrer">
              {link.label}
            </a>
          </p>
        ) : (
          <p class="dim">No source link is known for this Video.</p>
        )}
      </div>
    </div>
  );
}
