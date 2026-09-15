// gateway-patched-blob-client: replaces the fs-backed default with a
// @netlify/blobs adapter so state survives across Lambda invocations.
// Original file preserved as client.js.orig.
import { getStore } from '@netlify/blobs';

const storeName = 'addie';

const getBlobStore = () => {
  if (process.env.NETLIFY_BLOBS_CONTEXT) {
    return getStore(storeName);
  }
  const edgeURL = process.env.BLOBS_LOCAL_URL;
  const token = process.env.BLOBS_LOCAL_TOKEN;
  if (!edgeURL || !token) {
    throw new Error(
      'No Netlify Blobs context found and BLOBS_LOCAL_URL/BLOBS_LOCAL_TOKEN are not set.'
    );
  }
  return getStore({ name: storeName, edgeURL, token, siteID: 'local-dev-site' });
};

const set = async (key, value) => {
  await getBlobStore().set(key, value);
  return true;
};

const get = async (key) => {
  return await getBlobStore().get(key);
};

const del = async (key) => {
  await getBlobStore().delete(key);
  return true;
};

const createClient = () => ({ on: () => createClient });
createClient.connect = () => ({ set, get, del });

export { createClient };
