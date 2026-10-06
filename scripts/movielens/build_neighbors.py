# Vecinos ítem-ítem de MovieLens 32M para el motor v2 (docs/specs/motor-recomendaciones-v2.md, 3.3).
#
# "Gustó" = calificación >= 4.0 (señal implícita, como la que deducimos de Nuvio). Similitud coseno
# entre películas sobre esos gustos, con encogimiento para que dos películas con 3 fans en común no
# salgan "idénticas". Se guardan los 100 vecinos de cada película, con ids de TMDB.
import sqlite3, sys, time, zipfile
import numpy as np
import pandas as pd
from scipy import sparse

SRC = '/data/ml-32m.zip'
OUT = '/data/movielens.sqlite'
MIN_LIKES = 30      # películas con menos fans no tienen vecinos fiables
TOPK = 100
SHRINK = 25.0
LIKE = 4.0

t0 = time.time()
z = zipfile.ZipFile(SRC)
ratings = pd.read_csv(z.open('ml-32m/ratings.csv'), usecols=['userId', 'movieId', 'rating'],
                      dtype={'userId': np.int32, 'movieId': np.int32, 'rating': np.float32})
links = pd.read_csv(z.open('ml-32m/links.csv'), dtype={'movieId': np.int32, 'imdbId': str, 'tmdbId': 'Int64'})
print(f'{len(ratings):,} calificaciones leidas en {time.time()-t0:.0f}s', flush=True)

likes = ratings[ratings.rating >= LIKE][['userId', 'movieId']]
del ratings
counts = likes.movieId.value_counts()
keep = counts[counts >= MIN_LIKES].index
likes = likes[likes.movieId.isin(keep)]
links = links.dropna(subset=['tmdbId'])
likes = likes[likes.movieId.isin(links.movieId)]
print(f'{len(likes):,} gustos sobre {likes.movieId.nunique():,} peliculas', flush=True)

movie_ids = np.sort(likes.movieId.unique())
m_index = {m: i for i, m in enumerate(movie_ids)}
user_ids = likes.userId.unique()
u_index = pd.Series(np.arange(len(user_ids)), index=user_ids)
rows = u_index[likes.userId.values].values
cols = np.array([m_index[m] for m in likes.movieId.values])
X = sparse.csr_matrix((np.ones(len(rows), dtype=np.float32), (rows, cols)), shape=(len(user_ids), len(movie_ids)))
Xc = X.tocsc()
n_likes = np.asarray(X.sum(axis=0)).ravel()
norms = np.sqrt(n_likes)
tmdb_of = links.set_index('movieId').tmdbId.astype(np.int64).to_dict()
print(f'matriz {X.shape}, {X.nnz:,} valores', flush=True)

db = sqlite3.connect(OUT + '.tmp')
db.execute('DROP TABLE IF EXISTS neighbors')
db.execute('CREATE TABLE neighbors (tmdb_id INTEGER, neighbor INTEGER, score REAL)')
db.execute('DROP TABLE IF EXISTS movies')
db.execute('CREATE TABLE movies (tmdb_id INTEGER PRIMARY KEY, likes INTEGER)')
db.executemany('INSERT OR REPLACE INTO movies VALUES (?, ?)', [(int(tmdb_of[m]), int(n_likes[i])) for i, m in enumerate(movie_ids)])

XT = Xc.T.tocsr()
B = 500
n = len(movie_ids)
for start in range(0, n, B):
    end = min(n, start + B)
    co = (XT[start:end] @ X).toarray()  # (B, n) fans en común
    denom = np.outer(norms[start:end], norms) + SHRINK
    sim = co / denom
    for r in range(end - start):
        sim[r, start + r] = 0
    idx = np.argpartition(-sim, TOPK, axis=1)[:, :TOPK]
    batch = []
    for r in range(end - start):
        i = start + r
        nb = idx[r][np.argsort(-sim[r, idx[r]])]
        src = int(tmdb_of[movie_ids[i]])
        for j in nb:
            s = float(sim[r, j])
            if s <= 0: break
            batch.append((src, int(tmdb_of[movie_ids[j]]), round(s, 5)))
    db.executemany('INSERT INTO neighbors VALUES (?, ?, ?)', batch)
    if (start // B) % 10 == 0:
        print(f'{end:,}/{n:,} peliculas ({time.time()-t0:.0f}s)', flush=True)

db.execute('CREATE INDEX idx_neighbors ON neighbors (tmdb_id)')
db.commit()
db.close()
import os; os.replace(OUT + '.tmp', OUT)
print(f'listo en {time.time()-t0:.0f}s', flush=True)
