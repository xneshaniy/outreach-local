/**
 * Entry point named `server.js` at the repository root.
 *
 * This is the convention almost every Next.js deployment expects: the
 * Docker image runs "node server.js", and a hosting panel's Next.js preset
 * names server.js as the entry file. The real server lives in the build
 * output, so this file simply hands over to start.js, which picks the right
 * one.
 *
 * The Docker image copies .next/standalone over this file, so the container
 * still starts the standalone server directly - nothing changes there.
 */
require("./start.js");
