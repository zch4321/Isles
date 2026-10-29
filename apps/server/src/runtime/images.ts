import {
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_IMAGES,
  imageSchema,
  type MessageImage,
} from '@isles/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { HttpError } from '../errors.js';
import type { AgentRecord, ImageRecord, Store } from '../storage/store.js';
import type { AgentWorkspace } from './workspace.js';
import { workspacePathKey } from './workspace-paths.js';

export const MAX_IMAGE_DIMENSION = 8192;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGE_FRAMES = 100;

type ImageMimeType = MessageImage['mimeType'];
const formats = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
} as const satisfies Record<ImageMimeType, string>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pngCrcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function publicImage(image: ImageRecord): MessageImage {
  return imageSchema.parse(image);
}

function mimeFromSignature(bytes: Buffer): ImageMimeType | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  if (
    bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
    bytes.subarray(0, 6).toString('ascii') === 'GIF89a'
  )
    return 'image/gif';
  return undefined;
}

function inside(root: string, target: string): boolean {
  // Windows paths are case-insensitive and relative() uses the host's path semantics.
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function malformed(): never {
  throw new HttpError(400, '图片数据无效，请选择完整的图片');
}

function pngFrames(bytes: Buffer): number {
  let offset = 8;
  let header = false;
  let data = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) malformed();
    for (let index = offset + 4; index < offset + 8; index++) {
      const byte = bytes[index]!;
      if (!((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))) malformed();
    }
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    let crc = 0xffffffff;
    for (let index = offset + 4; index < offset + 8 + length; index++)
      crc = pngCrcTable[(crc ^ bytes[index]!) & 255]! ^ (crc >>> 8);
    if ((crc ^ 0xffffffff) >>> 0 !== bytes.readUInt32BE(offset + 8 + length)) malformed();
    if (!header) {
      if (type !== 'IHDR' || length !== 13) malformed();
      header = true;
    } else if (type === 'IHDR') malformed();
    if (type === 'IDAT') data = true;
    // The PNG decoder processes a single frame. GIF and WebP permit validation
    // of every animation frame before the original bytes are stored.
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT')
      throw new HttpError(400, '动画图片请使用 GIF 或 WebP');
    offset += 12 + length;
    if (type === 'IEND') {
      if (length !== 0 || !data || offset !== bytes.length) malformed();
      return 1;
    }
  }
  return malformed();
}

function gifFrames(bytes: Buffer): number {
  if (bytes.length < 14) malformed();
  const packed = bytes[10]!;
  let offset = 13 + ((packed & 0x80) !== 0 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  let frames = 0;
  const subBlocks = () => {
    while (offset < bytes.length) {
      const length = bytes[offset++]!;
      if (length === 0) return;
      if (offset + length > bytes.length) malformed();
      offset += length;
    }
    malformed();
  };
  while (offset < bytes.length) {
    const type = bytes[offset++]!;
    if (type === 0x3b) {
      if (offset !== bytes.length || frames === 0) malformed();
      return frames;
    }
    if (type === 0x21) {
      if (offset >= bytes.length) malformed();
      const label = bytes[offset++]!;
      if (label === 0xf9) {
        if (offset + 6 > bytes.length || bytes[offset] !== 4 || bytes[offset + 5] !== 0)
          malformed();
        offset += 6;
      } else {
        if ((label === 0xff && bytes[offset] !== 11) || (label === 0x01 && bytes[offset] !== 12))
          malformed();
        subBlocks();
      }
    } else if (type === 0x2c) {
      if (offset + 9 > bytes.length) malformed();
      if (!bytes.readUInt16LE(offset + 4) || !bytes.readUInt16LE(offset + 6)) malformed();
      const descriptor = bytes[offset + 8]!;
      offset += 9 + ((descriptor & 0x80) !== 0 ? 3 * 2 ** ((descriptor & 7) + 1) : 0);
      if (offset >= bytes.length || bytes[offset]! > 8 || bytes[offset] === 0) malformed();
      offset++; // LZW minimum code size.
      subBlocks();
      frames++;
    } else malformed();
  }
  return malformed();
}

function structuralFrames(bytes: Buffer, mimeType: ImageMimeType): number | undefined {
  if (mimeType === 'image/png') return pngFrames(bytes);
  if (mimeType === 'image/gif') return gifFrames(bytes);
  if (mimeType === 'image/jpeg') {
    if (bytes.length < 4 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9)
      malformed();
    return undefined;
  }
  if (bytes.readUInt32LE(4) !== bytes.length - 8) malformed();
  let offset = 12;
  let frames = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) malformed();
    if (bytes.toString('ascii', offset, offset + 4) === 'ANMF') frames++;
    const length = bytes.readUInt32LE(offset + 4);
    if (length + (length & 1) > bytes.length - offset - 8) malformed();
    offset += 8 + length + (length & 1);
  }
  return frames || 1;
}

async function inspect(bytes: Buffer): Promise<{
  mimeType: ImageMimeType;
  width: number;
  height: number;
}> {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new HttpError(400, '图片大小需在 10 MiB 以内');
  const mimeType = mimeFromSignature(bytes);
  if (!mimeType) throw new HttpError(400, '请选择 PNG、JPEG、WebP 或 GIF 图片');
  const declaredFrames = structuralFrames(bytes, mimeType);
  if (declaredFrames !== undefined && (declaredFrames < 1 || declaredFrames > MAX_IMAGE_FRAMES))
    throw new HttpError(400, '图片尺寸或帧数超过限制');
  try {
    const input = sharp(bytes, {
      failOn: 'warning',
      limitInputPixels: MAX_IMAGE_PIXELS,
      animated: true,
    });
    const metadata = await input.metadata();
    const width = metadata.width ?? 0;
    const frames = metadata.pages ?? 1;
    const height = metadata.pageHeight ?? metadata.height ?? 0;
    if (
      metadata.format !== (mimeType === 'image/jpeg' ? 'jpeg' : formats[mimeType]) ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      !Number.isInteger(frames) ||
      (declaredFrames !== undefined && frames !== declaredFrames) ||
      width < 1 ||
      height < 1 ||
      width > MAX_IMAGE_DIMENSION ||
      height > MAX_IMAGE_DIMENSION ||
      frames < 1 ||
      frames > MAX_IMAGE_FRAMES ||
      width * height * frames > MAX_IMAGE_PIXELS
    )
      throw new HttpError(400, '图片尺寸或帧数超过限制');
    // Metadata alone reads only headers. Stats forces every frame to decode while
    // preserving the original file bytes for storage and delivery.
    await input.stats();
    return { mimeType, width, height };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, '图片数据无效，请选择完整的图片');
  }
}

/** Durable original images and per-Agent workspace copies for native harnesses. */
export class MessageImages {
  private readonly copies = new Map<string, string>();
  private readonly materializing = new Map<string, Promise<string>>();

  constructor(
    private readonly store: Store,
    private readonly workspace: AgentWorkspace,
  ) {}

  private writableChannel(channelId: string): void {
    const channel = this.store.getChannel(channelId);
    if (channel.kind === 'group' && this.store.groupDeletedAt(channelId))
      throw new HttpError(409, '群聊已删除，历史只读');
    if (channel.kind === 'private' && this.store.getAgent(channel.agentId!).status === 'deleted')
      throw new HttpError(409, '该 Agent 已删除，私聊历史只读');
  }

  private member(agentId: string, channelId: string): AgentRecord {
    this.writableChannel(channelId);
    const agent = this.store.getAgent(agentId);
    if (agent.status === 'deleted') throw new HttpError(410, '该 Agent 已删除');
    if (!this.store.isMember(channelId, agentId))
      throw new HttpError(403, '请先将该 Agent 添加到频道');
    return agent;
  }

  path(image: Pick<MessageImage, 'id' | 'channelId' | 'mimeType'>): string {
    if (
      !uuid.test(image.id) ||
      !uuid.test(image.channelId) ||
      !Object.hasOwn(formats, image.mimeType)
    )
      throw new HttpError(400, '图片信息无效');
    return join(
      this.workspace.dataDir,
      'images',
      image.channelId,
      `${image.id}.${formats[image.mimeType]}`,
    );
  }

  private async checkDirectory(channelId: string): Promise<void> {
    const root = await realpath(this.workspace.dataDir);
    const directory = join(this.workspace.dataDir, 'images', channelId);
    const actual = await realpath(directory);
    if (workspacePathKey(actual) !== workspacePathKey(join(root, 'images', channelId)))
      throw new HttpError(400, '图片存储目录无法访问，请检查数据目录');
  }

  private async prepareDirectory(channelId: string): Promise<void> {
    const dataRoot = await realpath(this.workspace.dataDir);
    const imagesRoot = join(this.workspace.dataDir, 'images');
    const channelDirectory = join(imagesRoot, channelId);
    for (const [directory, expected] of [
      [imagesRoot, join(dataRoot, 'images')],
      [channelDirectory, join(dataRoot, 'images', channelId)],
    ]) {
      try {
        await mkdir(directory!, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const [entry, resolved] = await Promise.all([lstat(directory!), realpath(directory!)]);
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        workspacePathKey(resolved) !== workspacePathKey(expected!)
      )
        throw new HttpError(400, '图片存储目录无法访问，请检查数据目录');
    }
  }

  private async openImage(image: ImageRecord): Promise<FileHandle> {
    const file = this.path(image);
    await this.checkDirectory(image.channelId);
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const [opened, resolved, root] = await Promise.all([
        handle.stat(),
        realpath(file),
        realpath(this.workspace.dataDir),
      ]);
      const actual = await stat(resolved);
      const expected = join(root, 'images', image.channelId, basename(file));
      if (
        workspacePathKey(resolved) !== workspacePathKey(expected) ||
        !opened.isFile() ||
        opened.size !== image.size ||
        opened.dev !== actual.dev ||
        opened.ino !== actual.ino
      )
        throw new HttpError(400, '图片文件无法访问，请检查数据目录');
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async readBytes(image: ImageRecord, beforeRead?: () => void): Promise<Buffer> {
    const handle = await this.openImage(image);
    try {
      beforeRead?.();
      const buffer = Buffer.allocUnsafe(image.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const bytes = buffer.subarray(0, offset);
      if (
        offset !== image.size ||
        createHash('sha256').update(bytes).digest('hex') !== image.sha256
      )
        throw new HttpError(400, '图片文件内容已改变，请检查数据目录');
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async stream(image: MessageImage): Promise<Readable> {
    const saved = this.store.getImage(image.channelId, image.id);
    return Readable.from([await this.readBytes(saved)]);
  }

  async upload(channelId: string, bytes: Buffer, name: string): Promise<MessageImage> {
    this.writableChannel(channelId);
    if (!imageSchema.shape.name.safeParse(name).success)
      throw new HttpError(400, '请提供有效的图片文件名');
    const metadata = await inspect(bytes);
    // Parse the public shape before creating a file, including filename validation.
    const id = randomUUID();
    const image = imageSchema.safeParse({
      id,
      channelId,
      name,
      ...metadata,
      size: bytes.length,
      createdAt: new Date().toISOString(),
    });
    if (!image.success) throw new HttpError(400, '请提供有效的图片文件名');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // Check the channel after async decode and again in registerImage's transaction.
    this.writableChannel(channelId);
    const existing = this.store.findImage(channelId, sha256, name);
    if (existing) return publicImage(existing);
    const file = this.path(image.data);
    await this.prepareDirectory(channelId);
    let created = false;
    try {
      const handle = await open(file, 'wx', 0o600);
      created = true;
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      const saved = this.store.registerImage({
        id,
        channelId,
        name,
        ...metadata,
        size: bytes.length,
        sha256,
      });
      if (saved.id !== id) await rm(file);
      return publicImage(saved);
    } catch (error) {
      if (created) await rm(file, { force: true });
      throw error;
    }
  }

  async importFiles(
    agent: AgentRecord,
    channelId: string,
    paths: readonly string[],
  ): Promise<MessageImage[]> {
    if (paths.length > MAX_MESSAGE_IMAGES) throw new HttpError(400, '每条消息最多包含 4 张图片');
    const current = this.member(agent.id, channelId);
    const roots = current.dangerFullAccess
      ? []
      : (
          await Promise.all(
            [current.workspace, this.workspace.sharedDir, ...current.workspacePaths].map((root) =>
              realpath(root).catch(() => undefined),
            ),
          )
        ).filter((root): root is string => root !== undefined);
    const checkAccess = () => {
      const latest = this.member(agent.id, channelId);
      if (
        latest.dangerFullAccess !== current.dangerFullAccess ||
        latest.workspace !== current.workspace ||
        JSON.stringify(latest.workspacePaths) !== JSON.stringify(current.workspacePaths)
      )
        throw new HttpError(409, 'Agent 工作区设置已更新，请重试');
    };
    const files: { name: string; bytes: Buffer }[] = [];
    // Resolve and validate the whole batch before registering any files.
    for (const source of paths) {
      if (!isAbsolute(source)) throw new HttpError(400, '请提供图片文件的绝对路径');
      if (!imageSchema.shape.name.safeParse(basename(source)).success)
        throw new HttpError(400, '请提供有效的图片文件名');
      let canonical: string;
      try {
        canonical = await realpath(source);
      } catch {
        throw new HttpError(400, '图片文件无法访问，请检查路径');
      }
      if (!current.dangerFullAccess && !roots.some((root) => inside(root, canonical)))
        throw new HttpError(403, '图片文件需要位于 Agent 可访问的工作区');
      let handle;
      try {
        checkAccess();
        handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > MAX_IMAGE_BYTES)
          throw new HttpError(400, '图片文件大小需在 10 MiB 以内');
        // Check the open handle still identifies the resolved path, including on
        // Windows where O_NOFOLLOW is not available.
        const verified = await realpath(canonical);
        const verifiedStat = await stat(verified);
        if (
          (!current.dangerFullAccess && !roots.some((root) => inside(root, verified))) ||
          opened.dev !== verifiedStat.dev ||
          opened.ino !== verifiedStat.ino
        )
          throw new HttpError(403, '图片文件需要位于 Agent 可访问的工作区');
        checkAccess();
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          const bytes = chunk as Buffer;
          size += bytes.length;
          if (size > MAX_IMAGE_BYTES) throw new HttpError(400, '图片大小需在 10 MiB 以内');
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks, size);
        await inspect(bytes);
        files.push({ name: basename(source), bytes });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, '图片文件无法访问，请检查路径');
      } finally {
        await handle?.close();
      }
    }
    const result: MessageImage[] = [];
    for (const file of files) {
      checkAccess();
      result.push(await this.upload(channelId, file.bytes, file.name));
    }
    return result;
  }

  async materialize(
    agent: AgentRecord,
    images: readonly MessageImage[],
  ): Promise<Map<string, string>> {
    const current = this.store.getAgent(agent.id);
    for (const image of images) this.member(current.id, image.channelId);
    if (!images.length) return new Map();
    const directory = join(current.workspace, '.isles-images');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.checkCopyDirectory(current, directory);
    const result = new Map<string, string>();
    for (const image of images) {
      this.member(current.id, image.channelId);
      if (result.has(image.id)) continue;
      const saved = this.store.getImage(image.channelId, image.id);
      result.set(saved.id, await this.materializeCopy(current, saved, directory));
    }
    return result;
  }

  private async checkCopyDirectory(agent: AgentRecord, directory: string): Promise<void> {
    const [root, resolved, entry] = await Promise.all([
      realpath(agent.workspace),
      realpath(directory),
      lstat(directory),
    ]);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      workspacePathKey(resolved) !== workspacePathKey(join(root, '.isles-images'))
    )
      throw new HttpError(400, 'Agent 图片目录无法访问，请检查工作区');
  }

  private async matchesCopy(
    agent: AgentRecord,
    image: ImageRecord,
    directory: string,
    file: string,
  ): Promise<boolean> {
    let handle: FileHandle | undefined;
    try {
      await this.checkCopyDirectory(agent, directory);
      const entry = await lstat(file);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== image.size) return false;
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const [opened, resolved, root] = await Promise.all([
        handle.stat(),
        realpath(file),
        realpath(agent.workspace),
      ]);
      const expected = join(root, '.isles-images', basename(file));
      const actual = await stat(resolved);
      if (
        workspacePathKey(resolved) !== workspacePathKey(expected) ||
        !opened.isFile() ||
        opened.size !== image.size ||
        opened.dev !== actual.dev ||
        opened.ino !== actual.ino
      )
        return false;
      this.member(agent.id, image.channelId);
      const buffer = Buffer.allocUnsafe(image.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return (
        offset === image.size &&
        createHash('sha256').update(buffer.subarray(0, offset)).digest('hex') === image.sha256
      );
    } catch (error) {
      if (error instanceof HttpError) throw error;
      return false;
    } finally {
      await handle?.close();
    }
  }

  private async materializeCopy(
    agent: AgentRecord,
    image: ImageRecord,
    directory: string,
  ): Promise<string> {
    const key = `${agent.id}:${image.id}`;
    const pending = this.materializing.get(key);
    if (pending) {
      const file = await pending;
      this.member(agent.id, image.channelId);
      return file;
    }
    const operation = this.findOrCreateCopy(agent, image, directory, key);
    this.materializing.set(key, operation);
    try {
      const file = await operation;
      this.member(agent.id, image.channelId);
      return file;
    } finally {
      if (this.materializing.get(key) === operation) this.materializing.delete(key);
    }
  }

  private async findOrCreateCopy(
    agent: AgentRecord,
    image: ImageRecord,
    directory: string,
    key: string,
  ): Promise<string> {
    // The stored asset is authoritative, including when a prior copy can be reused.
    const bytes = await this.readBytes(image, () => {
      this.member(agent.id, image.channelId);
    });
    const check = async (file: string) => {
      if (!(await this.matchesCopy(agent, image, directory, file))) return false;
      this.member(agent.id, image.channelId);
      this.copies.set(key, file);
      return true;
    };
    const cached = this.copies.get(key);
    if (cached && (await check(cached))) return cached;
    this.copies.delete(key);
    this.member(agent.id, image.channelId);
    await this.checkCopyDirectory(agent, directory);
    const prefix = `${image.id}-`;
    const suffix = `.${formats[image.mimeType]}`;
    this.member(agent.id, image.channelId);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith(prefix) ||
        !entry.name.endsWith(suffix) ||
        !uuid.test(entry.name.slice(prefix.length, -suffix.length))
      )
        continue;
      const file = join(directory, entry.name);
      if (file !== cached && (await check(file))) return file;
    }
    this.member(agent.id, image.channelId);
    await this.checkCopyDirectory(agent, directory);
    const file = join(directory, `${prefix}${randomUUID()}${suffix}`);
    let created = false;
    try {
      const handle = await open(file, 'wx', 0o600);
      created = true;
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      if (!(await this.matchesCopy(agent, image, directory, file)))
        throw new HttpError(400, 'Agent 图片目录无法访问，请检查工作区');
      this.member(agent.id, image.channelId);
      this.copies.set(key, file);
      return file;
    } catch (error) {
      if (created) await rm(file, { force: true });
      throw error;
    }
  }

  async load(image: MessageImage): Promise<{ data: string; mimeType: ImageMimeType }> {
    const saved = this.store.getImage(image.channelId, image.id);
    return { data: (await this.readBytes(saved)).toString('base64'), mimeType: saved.mimeType };
  }
}
