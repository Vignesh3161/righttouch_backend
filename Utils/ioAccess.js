/**
 * 🔌 IO ACCESSOR — hands the socket.io instance to background workers
 * (crons, dispatch worker) without circular imports.
 * index.js calls setIo(io) right after the server starts; consumers call
 * getIo() at runtime (never at module top-level).
 */
let ioInstance = null;

export const setIo = (io) => {
  ioInstance = io;
};

export const getIo = () => ioInstance;