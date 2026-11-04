// Referencia externa del Visor de semillas: corre cubiomes (C, sin tocar) y escribe lo que calcula, una linea JSON
// por caso, para compararlo con el port en JS (compare.js). No se empaqueta ni la usa la app: carpeta test/.
//
// Se compila contra una copia de cubiomes (https://github.com/Cubitect/cubiomes, MIT). Ver build.txt.
//   harness published                     pruebas publicadas en tests.c de cubiomes (getRef, hashes b6)
//   harness all <semillas> <fuertes> [desde]  biomas, estructuras, puntos de aparicion y slime chunks
#include "finders.h"
#include "generator.h"
#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <inttypes.h>

// ---------- Hash de tests.c de cubiomes ----------
static uint32_t hash32(uint32_t x)
{
    x ^= x >> 15;
    x *= 0xd168aaad;
    x ^= x >> 15;
    x *= 0xaf723597;
    x ^= x >> 15;
    return x;
}

static uint64_t mix64(uint64_t x)
{
    x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ULL;
    x = (x ^ (x >> 27)) * 0x94d049bb133111ebULL;
    return x ^ (x >> 31);
}

static Generator g_gen;
static Generator *G = &g_gen;

// Copia de getRef() de tests.c: 4^bits semillas chicas, un punto por semilla
static uint32_t getRef(int mc, int dim, int bits, int scale)
{
    setupGenerator(G, mc, 0);
    int r = 1 << (bits-1);
    int h = 0;
    int x, z;
    for (x = -r; x < r; x++)
    {
        for (z = -r; z < r; z++)
        {
            int64_t s = (int64_t)( (z << bits) ^ x );
            applySeed(G, dim, s);
            int y = (int)((hash32((int)s) & 0x7fffffff) % 384 - 64) >> 2;
            int id = getBiomeAt(G, scale, x, y, z);
            h ^= hash32( (int) s ^ (id << 2*bits) );
        }
    }
    return h;
}

// ---------- Casos ----------
static const int64_t SPECIAL[] = {
    0, 1, -1, 2, 42, 12345, 8675309, -8675309, 1234567890123456789LL, -1234567890123456789LL,
    INT64_MAX, INT64_MIN, 2147483647LL, -2147483648LL, 281474976710656LL /* 2^48 */, 3257840388504953787LL,
};
static int64_t seedAt(int i)
{
    int n = sizeof(SPECIAL) / sizeof(SPECIAL[0]);
    return i < n ? SPECIAL[i] : (int64_t)mix64((uint64_t)i * 0x9e3779b97f4a7c15ULL);
}

static const struct { int mc; const char *key; } VERS[] = {
    { MC_1_18_2, "1.18" }, { MC_1_19_2, "1.19.2" }, { MC_1_19_4, "1.19.4" }, { MC_1_20_6, "1.20" },
    { MC_1_21_1, "1.21.1" }, { MC_1_21_3, "1.21.3" }, { MC_1_21_WD, "1.21.4" },
};
enum { NVERS = sizeof(VERS) / sizeof(VERS[0]) };

static const struct { int id; const char *key; } TYPES[] = {
    { Desert_Pyramid, "desert_pyramid" }, { Jungle_Temple, "jungle_temple" }, { Swamp_Hut, "swamp_hut" },
    { Igloo, "igloo" }, { Village, "village" }, { Monument, "monument" }, { Mansion, "mansion" },
    { Outpost, "outpost" }, { Ancient_City, "ancient_city" }, { Trail_Ruins, "trail_ruins" },
    { Trial_Chambers, "trial_chambers" },
};
enum { NTYPES = sizeof(TYPES) / sizeof(TYPES[0]) };

// Mismo hash que compare.js: encadena biomas celda por celda
static uint32_t mixId(uint32_t hash, int i, int id)
{
    return hash32(hash ^ hash32((uint32_t)id + ((uint32_t)i << 17)));
}

static void line_grid(const char *key, int dim, int64_t seed, const char *how, int step, int x, int z, int w, int h, int y, uint32_t hash, int n)
{
    printf("{\"k\":\"grid\",\"mc\":\"%s\",\"dim\":%d,\"seed\":\"%" PRId64 "\",\"how\":\"%s\",\"step\":%d,\"x\":%d,\"z\":%d,\"w\":%d,\"h\":%d,\"y\":%d,\"n\":%d,\"hash\":%u}\n",
        key, dim, seed, how, step, x, z, w, h, y, n, hash);
}

// Biomas de superficie o de una altura, celda 1:4 por celda 1:4 (con paso para los zooms alejados)
static void grid_over(const char *key, int64_t seed, int step, int x, int z, int w, int h, int y)
{
    uint32_t hash = 0;
    int i, j;
    for (j = 0; j < h; j++)
        for (i = 0; i < w; i++)
            hash = mixId(hash, j*w+i, sampleBiomeNoise(&G->bn, NULL, x + i*step, y, z + j*step, NULL, 0));
    line_grid(key, 0, seed, "cell", step, x, z, w, h, y, hash, w*h);
}

// Cruce con genBiomes (la entrada normal de cubiomes): tiene que dar lo mismo que celda por celda
static void grid_gen(const char *key, int dim, int64_t seed, int scale, int x, int z, int w, int h, int y)
{
    Range r = {scale, x, z, w, h, y, 1};
    int *ids = allocCache(G, r);
    genBiomes(G, ids, r);
    uint32_t hash = 0;
    int i;
    for (i = 0; i < w*h; i++)
        hash = mixId(hash, i, ids[i]);
    free(ids);
    line_grid(key, dim, seed, "gen", scale, x, z, w, h, y, hash, w*h);
}

static void grid_nether(const char *key, int64_t seed, int step, int x, int z, int w, int h)
{
    uint32_t hash = 0;
    int i, j;
    for (j = 0; j < h; j++)
        for (i = 0; i < w; i++)
            hash = mixId(hash, j*w+i, getNetherBiome(&G->nn, x + i*step, 0, z + j*step, NULL));
    line_grid(key, -1, seed, "cell", step, x, z, w, h, 0, hash, w*h);
}

static void structs(const char *key, int dim, int64_t seed, const char *tkey, int type, int rx0, int rz0, int rad)
{
    StructureConfig sc;
    if (!getStructureConfig(type, G->mc, &sc))
        return;
    printf("{\"k\":\"struct\",\"mc\":\"%s\",\"dim\":%d,\"seed\":\"%" PRId64 "\",\"type\":\"%s\",\"rx\":%d,\"rz\":%d,\"rad\":%d,\"list\":[",
        key, dim, seed, tkey, rx0, rz0, rad);
    int rx, rz, first = 1;
    for (rz = rz0-rad; rz <= rz0+rad; rz++)
    {
        for (rx = rx0-rad; rx <= rx0+rad; rx++)
        {
            Pos p;
            if (!getStructurePos(type, G->mc, (uint64_t)seed, rx, rz, &p))
                continue;
            int v = isViableStructurePos(type, G, p.x, p.z, 0);
            int t = 0;
            if (v)
                t = dim == 0 ? isViableStructureTerrain(type, G, p.x, p.z) : 1;
            printf("%s[%d,%d,%d,%d,%d,%d]", first ? "" : ",", rx, rz, p.x, p.z, v, t);
            first = 0;
        }
    }
    printf("]}\n");
}

static void strongholds(const char *key, int64_t seed, int count)
{
    StrongholdIter sh;
    initFirstStronghold(&sh, G->mc, (uint64_t)seed);
    printf("{\"k\":\"strong\",\"mc\":\"%s\",\"seed\":\"%" PRId64 "\",\"count\":%d,\"list\":[", key, seed, count);
    int i;
    for (i = 0; i < count; i++)
    {
        int left = nextStronghold(&sh, G);
        printf("%s[%d,%d]", i ? "," : "", sh.pos.x, sh.pos.z);
        if (left <= 0)
            break;
    }
    printf("]}\n");
}

static void spawnLine(const char *key, int64_t seed)
{
    Pos e = estimateSpawn(G, NULL);
    Pos s = getSpawn(G);
    printf("{\"k\":\"spawn\",\"mc\":\"%s\",\"seed\":\"%" PRId64 "\",\"est\":[%d,%d],\"pos\":[%d,%d]}\n", key, seed, e.x, e.z, s.x, s.z);
}

static void slimeLine(int64_t seed, int x, int z, int w, int h)
{
    uint32_t hash = 0;
    int i, j, n = 0;
    for (j = 0; j < h; j++)
    {
        for (i = 0; i < w; i++)
        {
            int v = isSlimeChunk((uint64_t)seed, x+i, z+j);
            n += v;
            hash = mixId(hash, j*w+i, v);
        }
    }
    printf("{\"k\":\"slime\",\"seed\":\"%" PRId64 "\",\"x\":%d,\"z\":%d,\"w\":%d,\"h\":%d,\"n\":%d,\"hash\":%u}\n", seed, x, z, w, h, n, hash);
}

static int coord(uint64_t s, int d) { return (int)(mix64(s) % (uint64_t)d) - d/2; }

static void runSeed(int idx, int64_t seed, int withStrong)
{
    int v, t;
    slimeLine(seed, -32, -32, 64, 64);
    slimeLine(seed, coord(idx*7+1, 2000000), coord(idx*7+2, 2000000), 32, 32);

    for (v = 0; v < NVERS; v++)
    {
        const char *key = VERS[v].key;
        setupGenerator(G, VERS[v].mc, 0);

        // ---------- Superficie del mundo ----------
        applySeed(G, DIM_OVERWORLD, (uint64_t)seed);
        const int ys[] = { 319>>2, 15, 0, -12 };
        int iy;
        for (iy = 0; iy < 4; iy++)
        {
            grid_over(key, seed, 1, -24, -24, 48, 48, ys[iy]);
            grid_over(key, seed, 1, coord(idx*11+iy, 40000), coord(idx*13+iy, 40000), 48, 48, ys[iy]);
        }
        grid_over(key, seed, 1, coord(idx*17, 3700000), coord(idx*19, 3700000), 32, 32, 319>>2);
        grid_over(key, seed, 4, coord(idx*23, 8000), coord(idx*29, 8000), 32, 32, 319>>2);
        grid_over(key, seed, 16, coord(idx*31, 32000), coord(idx*37, 32000), 32, 32, 319>>2);
        grid_over(key, seed, 64, coord(idx*41, 128000), coord(idx*43, 128000), 32, 32, 319>>2);
        grid_gen(key, 0, seed, 4, coord(idx*47, 40000), coord(idx*53, 40000), 32, 32, 319>>2);
        spawnLine(key, seed);
        for (t = 0; t < NTYPES; t++)
        {
            structs(key, 0, seed, TYPES[t].key, TYPES[t].id, 0, 0, 4);
            structs(key, 0, seed, TYPES[t].key, TYPES[t].id, coord(idx*59+t, 400), coord(idx*61+t, 400), 2);
        }
        if (withStrong)
            strongholds(key, seed, 128);
        else
            strongholds(key, seed, 3);

        // ---------- Nether ----------
        applySeed(G, DIM_NETHER, (uint64_t)seed);
        grid_nether(key, seed, 1, -32, -32, 64, 64);
        grid_nether(key, seed, 1, coord(idx*67, 40000), coord(idx*71, 40000), 48, 48);
        grid_nether(key, seed, 16, coord(idx*73, 32000), coord(idx*79, 32000), 32, 32);
        structs(key, -1, seed, "fortress", Fortress, 0, 0, 5);
        structs(key, -1, seed, "bastion", Bastion, 0, 0, 5);

        // ---------- End ----------
        applySeed(G, DIM_END, (uint64_t)seed);
        grid_gen(key, 1, seed, 4, -64, -64, 128, 128, 0);
        grid_gen(key, 1, seed, 16, -64, -64, 128, 128, 0);
        grid_gen(key, 1, seed, 16, coord(idx*83, 20000), coord(idx*89, 20000), 48, 48, 0);
        grid_gen(key, 1, seed, 64, -32, -32, 64, 64, 0);
        grid_gen(key, 1, seed, 256, -16, -16, 32, 32, 0);
        fflush(stdout);
    }
}

int main(int argc, char **argv)
{
    if (argc >= 2 && !strcmp(argv[1], "published"))
    {
        // tests.c de cubiomes, testGeneration(): mc_vers y b6_hashes (primeros cuatro, los de 1.18+)
        static const struct { int mc; const char *key; uint32_t expect; } T[] = {
            { MC_1_20, "1.20", 0x0f8888ab }, { MC_1_19, "1.19.4", 0x391c36ec },
            { MC_1_19_2, "1.19.2", 0xea3e8c1c }, { MC_1_18, "1.18", 0xade7f891 },
        };
        int i;
        for (i = 0; i < 4; i++)
        {
            uint32_t h = getRef(T[i].mc, 0, 6, 4);
            printf("{\"k\":\"ref\",\"mc\":\"%s\",\"dim\":0,\"bits\":6,\"scale\":4,\"hash\":%u,\"published\":%u}\n", T[i].key, h, T[i].expect);
        }
        // Las mismas cuentas en versiones sin hash publicado (referencia generada con este binario)
        static const struct { int mc; const char *key; } U[] = { { MC_1_21_1, "1.21.1" }, { MC_1_21_3, "1.21.3" }, { MC_1_21_WD, "1.21.4" } };
        for (i = 0; i < 3; i++)
            printf("{\"k\":\"ref\",\"mc\":\"%s\",\"dim\":0,\"bits\":6,\"scale\":4,\"hash\":%u}\n", U[i].key, getRef(U[i].mc, 0, 6, 4));
        static const struct { int dim; const char *key; int mc; } D[] = { { -1, "1.21.4", MC_1_21_WD }, { 1, "1.21.4", MC_1_21_WD } };
        for (i = 0; i < 2; i++)
            printf("{\"k\":\"ref\",\"mc\":\"%s\",\"dim\":%d,\"bits\":6,\"scale\":4,\"hash\":%u}\n", D[i].key, D[i].dim, getRef(D[i].mc, D[i].dim, 6, 4));
        return 0;
    }
    if (argc >= 4 && !strcmp(argv[1], "all"))
    {
        int n = atoi(argv[2]);
        int strong = atoi(argv[3]);
        int from = argc >= 5 ? atoi(argv[4]) : 0;
        int i;
        for (i = from; i < from + n; i++)
            runSeed(i, seedAt(i), i - from < strong);
        return 0;
    }
    fprintf(stderr, "uso: harness published | all <semillas> <fuertes> [desde]\n");
    return 2;
}
