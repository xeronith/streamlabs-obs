/**
 * This script is injected into guest webviews and used by the app
 * to expose small pieces of functionality based on the guest content.
 */

import electron from 'electron';
import uuid from 'uuid/v4';
import fs from 'fs';
import util from 'util';
import mime from 'mime';
import path from 'path';

interface IGuestApiRequest {
  id: string;
  webContentsId: number;
  methodPath: string[];
  args: any[];
}

interface IGuestApiResponse {
  id: string;
  error: boolean;
  result: any;
  resultProcessing: EResponseResultProcessing;
}

interface IGuestApiCallback {
  requestId: string;
  callbackId: string;
  args: any[];
}

enum EResponseResultProcessing {
  None = 'none',
  File = 'file',
}

(() => {
  const readFile = util.promisify(fs.readFile);

  // No guest content should ever be able to pop up alert/confirm boxes
  window.alert = window.confirm = () => {
    throw new Error('Alert and Confirm are disabled in this context');
  };

  // eslint-disable-next-line no-eval
  global.eval = function() {
    throw new Error('Eval is disabled for security');
  };

  interface IRequest {
    resolve: (val: any) => void;
    reject: (val: any) => void;
    callbacks: {
      [callbackId: string]: Function;
    };
  }

  const requests: {
    [requestId: string]: IRequest;
  } = {};

  let hostWebContents: Electron.WebContents;
  let ipcChannel: string;
  const webContentsId = electron.remote.getCurrentWebContents().id;
  const requestBuffer: IGuestApiRequest[] = [];

  let readyFunc: Function;
  const readyPromise = new Promise<boolean>(resolve => {
    readyFunc = (webContentsId: number, ipc: string) => {
      hostWebContents = electron.remote.webContents.fromId(webContentsId);
      ipcChannel = ipc;

      requestBuffer.forEach(req => {
        hostWebContents.send(ipcChannel, req);
      });
      resolve();
    };
  });

  electron.ipcRenderer.on('guestApiCallback', (event: any, response: IGuestApiCallback) => {
    // This window was likely reloaded and no longer cares about this callback.
    if (!requests[response.requestId]) return;
    requests[response.requestId].callbacks[response.callbackId](...response.args);
  });

  electron.ipcRenderer.on('guestApiResponse', async (event: any, response: IGuestApiResponse) => {
    if (!requests[response.id]) return;

    let result: any;

    // Perform any processing on the result if required
    if (response.resultProcessing === EResponseResultProcessing.File) {
      result = await readFile(response.result).then(data => {
        const parsed = path.parse(response.result);
        return new File([data], parsed.base, { type: mime.getType(parsed.ext) });
      });
    } else {
      result = response.result;
    }

    if (response.error) {
      requests[response.id].reject(result);
    } else {
      requests[response.id].resolve(result);
    }

    // Delete the request object if there aren't any callbacks
    // to avoid leaking too much memory.
    if (Object.keys(requests[response.id].callbacks).length === 0) {
      delete requests[response.id];
    }
  });

  electron.ipcRenderer.on(
    'guestApiReady',
    (e: Electron.Event, info: { webContentsId: number; ipcChannel: string }) => {
      readyFunc(info.webContentsId, info.ipcChannel);
    },
  );

  /**
   * Returns a proxy rooted at the given path
   * @param path the current path
   */
  function getProxy(path: string[] = []): any {
    return new Proxy(() => {}, {
      get(target, key) {
        if (key === 'apiReady') {
          return readyPromise;
        }

        return getProxy(path.concat([key.toString()]));
      },

      apply(target, thisArg, args: any[]) {
        const requestId = uuid();
        requests[requestId] = {
          resolve: null,
          reject: null,
          callbacks: {},
        };
        const promise = new Promise((resolve, reject) => {
          requests[requestId].resolve = resolve;
          requests[requestId].reject = reject;
        });
        const mappedArgs = args.map(arg => {
          if (typeof arg === 'function') {
            const callbackId = uuid();

            requests[requestId].callbacks[callbackId] = arg;

            return {
              __guestApiCallback: true,
              id: callbackId,
            };
          }

          return arg;
        });

        const apiRequest: IGuestApiRequest = {
          webContentsId,
          id: requestId,
          methodPath: path,
          args: mappedArgs,
        };

        if (hostWebContents && ipcChannel) {
          hostWebContents.send(ipcChannel, apiRequest);
        } else {
          requestBuffer.push(apiRequest);
        }

        return promise;
      },
    });
  }

  global['streamlabsOBS'] = getProxy();
})();
