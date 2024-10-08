import DBStore from "../db-store";
import logger from "./logger";
import Parser from "./parser";
import fs from "fs";
import Validator from "./validator";
import sleep from "./sleep";

interface KDBInfoData {
  "kdb-version": string;
  id: string;
  path: string;
  "snapshot-time": string;
  collections: number;
  points: number;
  size: number;
}

export default class KDB {
  path: string;
  saveperiod: number;
  loopStrated: boolean = false;
  writing: boolean = false;
  loading: boolean = false;

  constructor(path: string, saveperiod: number) {
    this.path = path;
    this.saveperiod = saveperiod;
  }

  async load(store: DBStore, onFinish?: () => any) {
    this.loading = true;

    try {
      logger.info(`loading snapshot from ${this.path}`);

      const file = fs.readFileSync(this.path);
      const content = file.toString();
      logger.info(`loaded kdb file to memory`);

      const info = this.grapInfo(content);
      const data = this.grapData(content);
      const collections = this.grapCollections(content);

      for (const key in info) {
        logger.info(`[snapshot-info] ${key}: ${info[key as keyof KDBInfoData]}`);
      }

      store.commands = data;
      store.collections = collections;
      store.collectionsIds = collections.map((c) => c.id);
      store.collectionsValidators = new Map(
        collections.map((c) => [c.id, new Validator(c)])
      );

      logger.info("loading commands lookup table... (this may take a while)");
      let now = Date.now();
      const commandsLookup: [string, string][] = [];

      const func = (key: string, value: string) => {
        commandsLookup.push([key, value]);
      }

      for (let i = 0; i < data.length; i++) {
        const d = data[i];
        commandsLookup.push([d.split("<-KC->")[0], d]);
      }

      store.commandsLookup = new Map(commandsLookup);
      logger.info(`loaded snapshot from ${this.path} in ${Date.now() - now}ms`);

      onFinish?.();
    } catch (err: any) {
      if (err.code === "ENOENT") {
        logger.warn(`snapshot file ${this.path} not found. will create it`);
        await this.write(store);
        onFinish?.();
        return;
      }
      logger.error(`error loading snapshot: ${err.message || err}`);
    } finally {
      this.loading = false;
    }
  }

  grapInfo(content: string) {
    const start =
      content.indexOf("--KDB-INFO-START--\r\n") +
      "--KDB-INFO-START--\r\n".length;
    const end = content.indexOf("--KDB-INFO-END--\r\n");
    const info = content.slice(start, end);
    const json = Parser.readKDBJson(info) as KDBInfoData;

    return json;
  }

  grapData(content: string) {
    const start =
      content.indexOf("--KDB-DATA-START--\r\n") +
      "--KDB-DATA-START--\r\n".length;
    const end = content.indexOf("--KDB-DATA-END--");
    const data = content.slice(start, end);
    const d = data.split("<-KCOMMAND->");

    return d;
  }

  grapCollections(content: string) {
    const start =
      content.indexOf("--KDB-COLLECTIONS-START--\r\n") +
      "--KDB-COLLECTIONS-START--\r\n".length;
    const end = content.indexOf("--KDB-COLLECTIONS-END--");
    const data = content.slice(start, end);
    const json = Parser.readKDBJson(data);

    return json as Collection[];
  }

  async write(store: DBStore) {
    if (this.writing || this.loading) return;
    logger.info("writing snapshot to disk...");

    try {
      this.writing = true;
      const now = Date.now();

      // Parallel processing of parts
      const [data] = this.stringData(store);
      const id = `${store.id}-${store.role}-${now}`;

      const infoPromise = new Promise((resolve) => {
        const info = this.buildInfo(id, store, data);
        resolve(Parser.toKDBJson(info));
      })

      const collectionsPromise = new Promise((resolve) => {
        resolve(Parser.toKDBJson(store.collections));
      })

      const [infoJson, collectionsJson] = await Promise.all([
        infoPromise,
        collectionsPromise,
      ]);

      let content: string = "";

      // info part
      content += `--KDB-INFO-START--\r\n${infoJson}--KDB-INFO-END--\r\n`;

      // data part
      content += `--KDB-DATA-START--\r\n${data}--KDB-DATA-END--\r\n`;

      // collections part
      content += `--KDB-COLLECTIONS-START--\r\n${collectionsJson}--KDB-COLLECTIONS-END--\r\n`;

      logger.info(`built snapshot in ${Date.now() - now}ms`);

      const writeStartTime = Date.now();

      fs.writeFileSync(this.path, content, "utf8");

      logger.info(
        `wrote ${store.commandsLookup.size} points to ${this.path} in ${
          Date.now() - writeStartTime
        }ms`
      );
    } catch (err) {
      logger.error(`error writing snapshot: ${err}`);
    } finally {
      this.writing = false;
    }
  }

  stringData(store: DBStore): [string] {
    let commandsContent = "";
    const delimiter = "<-KCOMMAND->";
    const iterator = store.commandsLookup.values();

    for (const command of iterator) {
      commandsContent += command;
      commandsContent += delimiter;
    }

    return [commandsContent];
  }

  buildInfo(id: string, store: DBStore, data: string): KDBInfoData {
    const snapshottime = Date.now();
    const path = this.path;
    const csum = store.collections.length;
    const size = Buffer.byteLength(data);

    return {
      id,
      "kdb-version": "1.0.0",
      path,
      "snapshot-time": snapshottime.toString(),
      collections: csum,
      points: store.commandsLookup.size,
      size
    };
  }

  writeLoop(getStore: () => DBStore) {
    if (this.loopStrated) {
      logger.error("write loop already started");
      return;
    }

    this.loopStrated = true;

    setInterval(() => {
      const store = getStore();
      this.write(store);
    }, this.saveperiod);

    process.on("SIGINT", async () => {
      logger.info("SIGINT signal received. making sure to persist data");
      if (this.loading) return;

      while (this.writing) {
        await sleep(10);
      }

      await this.write(getStore());
      process.exit();
    });

    logger.info(`snapshot will be saved every ${this.saveperiod}ms`);
  }
}
