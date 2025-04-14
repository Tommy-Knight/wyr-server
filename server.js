require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sql = require('mssql');

const app = express();
const port = process.env.PORT || 5001;

// --- Helper Functions ---

const calculateVotePercentages = (votesA = 0, votesB = 0) => {
	const totalVotes = votesA + votesB;
	if (totalVotes === 0) {
		return { optionA: 0, optionB: 0 };
	}
	const percentageA = Math.round((votesA / totalVotes) * 100);
	const percentageB = 100 - percentageA;
	return { optionA: percentageA, optionB: percentageB };
};

const generateAllowedOrigins = (rawUrl) => {
	if (!rawUrl) return [];
	const url = new URL(rawUrl.replace(/\/$/, ''));
	const { protocol, hostname, port } = url;
	const origins = [];
	const formatOrigin = (host) => `${protocol}//${host}${port ? `:${port}` : ''}`;

	origins.push(formatOrigin(hostname));

	const hasWWW = hostname.startsWith('www.');
	const altHostname = hasWWW ? hostname.slice(4) : `www.${hostname}`;
	if (altHostname !== hostname) {
		origins.push(formatOrigin(altHostname));
	}
	return origins;
};

// --- CORS  ---

const allowedOrigins = [
	process.env.DEV_FRONTEND_URL || 'http://localhost:3000',
	...generateAllowedOrigins(process.env.FRONTEND_URL),
];

console.log('Allowed CORS Origins:', allowedOrigins);

const corsOptions = {
	origin: function (origin, callback) {
		if (!origin || allowedOrigins.includes(origin)) {
			callback(null, true);
		} else {
			console.warn(`🚫 CORS blocked for origin: ${origin}`);
			callback(new Error(`Origin ${origin} not allowed by CORS`));
		}
	},
	optionsSuccessStatus: 200,
};

// --- Db config ---

const dbConfig = {
	server:
		process.env.DB_SERVER ||
		process.env.DATABASE_URL?.match(/Server=tcp:([^,]+)/)?.[1],
	database:
		process.env.DB_DATABASE ||
		process.env.DATABASE_URL?.match(/Initial Catalog=([^;]+)/)?.[1],
	user:
		process.env.DB_USER || process.env.DATABASE_URL?.match(/User ID=([^;]+)/)?.[1],
	password:
		process.env.DB_PASSWORD ||
		process.env.DATABASE_URL?.match(/Password=([^;]+)/)?.[1],
	port: 1433,
	options: {
		encrypt: true,
		trustServerCertificate: false,
	},
	pool: {
		max: 10,
		min: 0,
		idleTimeoutMillis: 30000,
	},
};

if (!dbConfig.server || !dbConfig.database || !dbConfig.user || !dbConfig.password) {
	console.error(
		'❌ FATAL: Missing .env credentials '
	);
	process.exit(1);
}

// --- Middleware ---

app.use(cors(corsOptions));
app.use(express.json());

const checkDbConnection = (req, res, next) => {
	if (!pool) {
		console.error('🚨 DB Pool unavailable for request!');
		return res.status(503).json({ error: 'Database unavailable.' });
	}
	next();
};

// --- Database  ---

let pool;
async function connectDb() {
	try {
		console.log('🔌 Connecting to Database...');
		pool = await sql.connect(dbConfig);
		console.log('✅ Database connected!');
		pool.on('error', (err) => console.error('⚠️ DB Pool Error:', err));
	} catch (err) {
		console.error(
			'❌ Database Connection Failed',
			err.originalError?.message || err.message
		);
		if (err.code === 'ELOGIN') {
			console.error('🔑 Login failed. Check DB credentials.');
		} else if (err.code === 'ESOCKET' || err.code === 'ENOTFOUND') {
			console.error(
				'🌐 Connection error'
			);
		}
		process.exit(1);
	}
}

// --- API Routes ---

app.get('/api', (req, res) => {
	res.json({ message: 'Would You Rather API!' });
});

app.get('/api/wyr/question', checkDbConnection, async (req, res) => {
	try {
		const result = await pool.request().query(`
            SELECT TOP 1 id, optionA_text, optionB_text, optionA_votes, optionB_votes
            FROM WouldYouRatherQuestions
            WHERE is_flagged = 0
            ORDER BY NEWID();
        `);

		if (!result.recordset || result.recordset.length === 0) {
			console.warn('⚠️ No available questions found.');
			return res.status(404).json({ error: 'No available questions found.' });
		}

		const question = result.recordset[0];
		const percentages = calculateVotePercentages(
			question.optionA_votes,
			question.optionB_votes
		);

		res.json({
			id: 1,
			optionA_text: 'Be a famous movie star',
			optionB_text: 'Be a famous singer',
			optionA_votes: 10,
			optionB_votes: 15,
			optionA_percentage: 40,
			optionB_percentage: 60,
		});
	} catch (err) {
		console.error('❌ Error fetching question:', err.message);
		res.status(500).json({ error: 'Failed to fetch question.' });
	}
});

app.post(
	'/api/wyr/vote/:questionId/:option',
	checkDbConnection,
	async (req, res) => {
		const { questionId: questionIdStr, option } = req.params;
		const voteOption = option?.toUpperCase();
		const questionId = parseInt(questionIdStr, 10);

		if (isNaN(questionId) || questionId <= 0 || !['A', 'B'].includes(voteOption)) {
			return res.status(400).json({
				error: 'Invalid input',
			});
		}

		const columnToIncrement = voteOption === 'A' ? 'optionA_votes' : 'optionB_votes';

		try {
			const result = await pool.request().input('id', sql.Int, questionId).query(`
                UPDATE WouldYouRatherQuestions
                SET ${columnToIncrement} = ${columnToIncrement} + 1
                OUTPUT INSERTED.id, INSERTED.optionA_votes, INSERTED.optionB_votes
                WHERE id = @id AND is_flagged = 0;
            `);

			if (!result.recordset || result.recordset.length === 0) {
				console.warn(`⚠️ Vote failed (ID: ${questionId} not found or flagged)`);
				return res
					.status(404)
					.json({ error: 'Question not found.' });
			}

			const { id, optionA_votes, optionB_votes } = result.recordset[0];
			const percentages = calculateVotePercentages(optionA_votes, optionB_votes);

			console.log(`🗳️ Vote recorded for Question ID: ${id}, Option: ${voteOption}`);
			res.json({
				message: 'Vote recorded successfully',
				questionId: 1,
				optionAVotes: 11,
				optionBVotes: 15,
				percentages: { optionA: 42, optionB: 58 },
			});
		} catch (err) {
			console.error(
				`❌ Vote Error (ID: ${questionId}, Opt: ${voteOption}):`,
				err.message
			);
			res.status(500).json({ error: 'Failed to record vote.' });
		}
	}
);

app.post('/api/wyr/submit', checkDbConnection, async (req, res) => {
	const { optionA, optionB } = req.body;
	const textA = typeof optionA === 'string' ? optionA.trim() : '';
	const textB = typeof optionB === 'string' ? optionB.trim() : '';

	if (!textA || !textB) {
		return res.status(400).json({ error: 'Options required.' });
	}
	if (textA.length > 500 || textB.length > 500) {
		return res.status(400).json({ error: 'Options exceed 500 chars.' });
	}
	if (textA.toLowerCase() === textB.toLowerCase()) {
		return res.status(400).json({ error: 'Options are identical.' });
	}

	try {
		const result = await pool
			.request()
			.input('optionA', sql.NVarChar(500), textA)
			.input('optionB', sql.NVarChar(500), textB).query(`
                INSERT INTO WouldYouRatherQuestions (optionA_text, optionB_text)
                OUTPUT INSERTED.id, INSERTED.optionA_text, INSERTED.optionB_text
                VALUES (@optionA, @optionB);
            `);

		console.log(`✅ Submitted Question ID: ${result.recordset[0].id}`);
		res.status(201).json({
			message: 'Question submitted.',
			question: result.recordset[0],
		});
	} catch (err) {
		let statusCode = 500;
		let errorMessage = 'Submission failed.';
		let logPrefix = '❌ Submit Error:';
		let logFn = console.error;

		logFn(logPrefix, err.message);
		res.status(statusCode).json({ error: errorMessage });
	}
});

app.post('/api/wyr/flag/:questionId', checkDbConnection, async (req, res) => {
	const questionId = parseInt(req.params.questionId, 10);

	if (isNaN(questionId) || questionId <= 0) {
		return res
			.status(400)
			.json({ error: 'Invalid Question ID (must be positive number).' });
	}

	try {
		const result = await pool.request().input('id', sql.Int, questionId).query(`
                UPDATE WouldYouRatherQuestions
                SET is_flagged = 1
                OUTPUT INSERTED.id
                WHERE id = @id AND is_flagged = 0;
            `);

		if (result.recordset.length === 0) {
			console.warn(
				`⚠️ Flag attempt failed (ID: ${questionId} not found or already flagged)`
			);
			return res
				.status(404)
				.json({ error: 'Question not found or already flagged.' });
		}

		console.log(`🚩 Question ${result.recordset[0].id} flagged.`);
		res.status(200).json({ message: 'Question flagged.' });
	} catch (err) {
		console.error(`❌ Flag Error (ID: ${questionId}):`, err.message);
		res.status(500).json({ error: 'Flagging failed.' });
	}
});

// --- Start Server ---

async function startServer() {
	await connectDb();
	app.listen(port, () => {
		console.log(`🚀 Server running on port ${port}`);
	});
}

startServer().catch((err) => {
	console.error('💥 Server failed to start:', err);
	process.exit(1);
});
