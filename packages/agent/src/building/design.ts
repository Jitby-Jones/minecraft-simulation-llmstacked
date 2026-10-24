// A building as builders describe it (owner request, 2026-10-24: buildings researched from real builds, and new ones
// designed by the agents' own architect). Not block by block, which models get wrong, but in parts a builder would
// name: one, two or three rectangular parts (an L or a T), a wall height, walls of a material with posts at the corners
// and beams between floors, a roof of a style and a material, a door, windows, what is inside, a few named features,
// and any odd blocks of its own (details). compile.ts turns it into blocks. A farm, a pen, a well or a lamp post is a
// plot instead of parts.

import { z } from 'zod';

const Side = z.enum(['north', 'east', 'south', 'west']);
const Block = z.string().regex(/^[a-z0-9_]+(\[[a-z0-9_=,]+\])?$/, 'a block name like oak_planks');
const Cell = z.tuple([z.number().int().min(-2).max(40), z.number().int().min(-1).max(40), z.number().int().min(-2).max(40)]);

export const RoofSchema = z.object({
  style: z.enum(['gable', 'hip', 'flat', 'shed']),
  /** A wood (oak, spruce, birch, jungle, acacia, dark_oak, mangrove, cherry) or a stone (cobblestone, stone_brick, sandstone, brick, deepslate_brick, mud_brick). */
  material: z.string().regex(/^[a-z_]+$/),
  /** Gable: the ridge runs along this axis. Shed: the roof rises toward +x or +z. */
  axis: z.enum(['x', 'z']).optional(),
  overhang: z.number().int().min(0).max(1).default(1),
  /** Flat roofs: a rim round the edge (fences on wood, slabs on stone). */
  rim: z.boolean().default(true),
});

export const PartSchema = z.object({
  /** Where the part's north-west corner is (x, z), so parts make an L or a T. */
  at: z.tuple([z.number().int().min(0).max(24), z.number().int().min(0).max(24)]).default([0, 0]),
  /** Outside size, walls included: [width along x, depth along z]. */
  size: z.tuple([z.number().int().min(3).max(15), z.number().int().min(3).max(15)]),
  floors: z.number().int().min(1).max(3).default(1),
  foundation: Block.default('cobblestone'),
  /** One material for all floors, or one per floor from the ground up. */
  walls: z.union([Block, z.array(Block).min(1).max(3)]),
  /** Corner posts (logs stand upright). */
  posts: Block.optional(),
  /** The band between floors (logs lie along the wall). */
  beams: Block.optional(),
  /** Upper floors (default: planks of the roof's wood, or of the posts'). */
  floor: Block.optional(),
  roof: RoofSchema,
  windows: z.object({ block: Block.default('glass_pane'), every: z.number().int().min(2).max(8).default(3), sides: z.array(Side).optional() }).optional(),
});

export const FeatureSchema = z.object({
  type: z.enum(['chimney', 'porch', 'fence', 'path', 'lamp']),
  side: Side.optional(),
  material: Block.optional(),
});

export const PlotSchema = z.object({
  type: z.enum(['farm', 'pen', 'well', 'lamp']),
  size: z.tuple([z.number().int().min(1).max(15), z.number().int().min(1).max(15)]).default([7, 7]),
  material: Block.optional(),
  side: Side.default('south'),
});

export const KINDS = ['house', 'cottage', 'hut', 'cabin', 'tower', 'workshop', 'smithy', 'storage', 'barn', 'hall', 'shop', 'library', 'farm', 'pen', 'well', 'lamp', 'shrine', 'other'] as const;

export const DesignSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    name: z.string().min(1).max(60),
    kind: z.enum(KINDS).default('house'),
    description: z.string().max(400).default(''),
    style: z.array(z.string().max(30)).max(8).default([]),
    /** Where it came from: photographs it was drawn from, the repertoire, an architect. */
    source: z.string().max(300).default(''),
    /** Wall height of each floor, in blocks. */
    wallHeight: z.number().int().min(2).max(6).default(3),
    parts: z.array(PartSchema).max(3).default([]),
    door: z
      .object({
        part: z.number().int().min(0).max(2).default(0),
        side: Side.default('south'),
        /** Along the side, from its west or north end; the middle when left out. */
        offset: z.number().int().min(1).max(13).optional(),
        double: z.boolean().default(false),
        material: z.string().regex(/^[a-z_]+$/).optional(),
      })
      .default({ part: 0, side: 'south', double: false }),
    /**
     * Along the inside walls, the ground floor first (upstairs when it is full): bed, chest, crafting_table, furnace,
     * bookshelf, barrel, table, chair, lantern, plant, anvil, ... "bed@1" puts it on the floor above the ground.
     */
    interior: z.array(z.string().regex(/^[a-z_]+(@[0-2])?$/, 'a block name, or name@floor like bed@1')).max(24).default([]),
    lights: z.enum(['torches', 'lanterns', 'none']).default('torches'),
    features: z.array(FeatureSchema).max(6).default([]),
    /** Blocks of its own, by position in the design (west-north-bottom corner of the first part at 0,0,0; y 0 is the ground). */
    details: z.array(z.object({ block: Block, at: Cell })).max(80).default([]),
    plot: PlotSchema.optional(),
  })
  .superRefine((d, ctx) => {
    if (d.parts.length === 0 && !d.plot) ctx.addIssue({ code: 'custom', message: 'a design needs parts (a building) or a plot (a farm, a pen, a well, a lamp)' });
    if (d.parts.length > 0 && d.door.part >= d.parts.length) ctx.addIssue({ code: 'custom', message: `the door is on part ${d.door.part}, and there are only ${d.parts.length}` });
  });

export type Design = z.infer<typeof DesignSchema>;
export type DesignInput = z.input<typeof DesignSchema>;
export type Part = z.infer<typeof PartSchema>;
export type Roof = z.infer<typeof RoofSchema>;
export type Side = z.infer<typeof Side>;
