import { parseArgs } from 'node:util';

const artPackages = Object.freeze({ '1.1.1': 'art-map-slice', '1.1.2': 'art-map-slice-v2' });

export function readUiReviewOptions(args, { defaultArtReview = false } = {}) {
  const { values } = parseArgs({ args, options: {
    'art-review': { type: 'boolean' }, 'art-version': { type: 'string' }, interactive: { type: 'boolean' },
  } });
  const artReview = defaultArtReview || values['art-review'] === true || values['art-version'] !== undefined;
  const mapVersion = artReview ? values['art-version'] ?? '1.1.1' : '1.1.0';
  if (artReview && !Object.hasOwn(artPackages, mapVersion)) throw new Error('Unknown isolated art-review version');
  return {
    artReview, mapVersion, interactive: values.interactive === true,
    sessionName: !artReview ? 'ui-local-session' : mapVersion === '1.1.1' ? 'ui-art-session' : `ui-art-session-${mapVersion}`,
    archiveDirectory: artReview ? artPackages[mapVersion] : null,
  };
}
