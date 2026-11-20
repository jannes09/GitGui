import { createContext, useContext, useEffect, useState } from 'react';
import { NO_SOURCES, loadPicture, peekPicture, type PictureSources } from '../avatars';
import { initials } from '../util';

/** Which picture sources are switched on (App provides this from the settings and the saved accounts). */
const SourcesContext = createContext<PictureSources>(NO_SOURCES);
export const PictureSourcesProvider = SourcesContext.Provider;

/**
 * The address of an author's profile picture once it is known to load, or null: the caller then shows initials.
 * Nothing is requested when no source is switched on.
 */
export function useAuthorPicture(email: string | undefined): string | null {
  const sources = useContext(SourcesContext);
  const [url, setUrl] = useState<string | null>(() => peekPicture(email, sources) ?? null);

  useEffect(() => {
    const known = peekPicture(email, sources);
    if (known !== undefined) {
      setUrl(known);
      return;
    }
    setUrl(null);
    let current = true;
    void loadPicture(email, sources).then((found) => {
      if (current) setUrl(found);
    });
    return () => {
      current = false;
    };
  }, [email, sources]);

  return url;
}

/** The round author avatar in the commit panel: the profile picture when there is one, else the initials. */
export function AuthorAvatar({ name, email }: { name: string; email?: string }) {
  const picture = useAuthorPicture(email);
  return (
    <div className={'avatar' + (picture ? ' has-picture' : '')} title={name}>
      {picture ? <img src={picture} alt="" referrerPolicy="no-referrer" draggable={false} /> : initials(name)}
    </div>
  );
}
