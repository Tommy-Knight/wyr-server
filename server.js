// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sql = require('mssql');

const app = express();
const port = process.env.PORT || 5001;

// --- CORS Configuration ---
const allowedOrigins = [];

// Add development URL if defined
if (process.env.DEV_FRONTEND_URL) {
	allowedOrigins.push(process.env.DEV_FRONTEND_URL); // e.g., http://localhost:3000
} else {
	// Fallback for local development if DEV_FRONTEND_URL isn't set
	allowedOrigins.push('http://localhost:3000');
}

// Add Production URL(s) based on FRONTEND_URL
if (process.env.FRONTEND_URL) {
	const prodUrl = process.env.FRONTEND_URL.replace(/\/$/, ''); // Remove trailing slash if present
	allowedOrigins.push(prodUrl);

	try {
		const url = new URL(prodUrl);
		if (!url.hostname.startsWith('www.')) {
			// Add www. version if base URL doesn't have it
			const wwwHostname = 'www.' + url.hostname;
			const wwwUrl = `${url.protocol}//${wwwHostname}${
				url.port ? ':' + url.port : ''
			}${url.pathname}`;
			allowedOrigins.push(wwwUrl.replace(/\/$/, ''));
		} else if (url.hostname.startsWith('www.')) {
			// Add non-www. version if base URL has it
			const nonWwwHostname = url.hostname.substring(4);
			const nonWwwUrl = `${url.protocol}//${nonWwwHostname}${
				url.port ? ':' + url.port : ''
			}${url.pathname}`;
			allowedOrigins.push(nonWwwUrl.replace(/\/$/, ''));
		}
	} catch (e) {
		console.error('Error parsing FRONTEND_URL for www/non-www variations:', e);
		// If parsing fails, we still have the original prodUrl in the list
	}
}

console.log('Allowed CORS Origins:', allowedOrigins); // Log allowed origins on startup

const corsOptions = {
	origin: function (origin, callback) {
		if (!origin || allowedOrigins.indexOf(origin) !== -1) {
			callback(null, true);
		} else {
			console.warn(`CORS blocked for origin: ${origin}`);
			callback(new Error(`Origin ${origin} not allowed by CORS`));
		}
	},
	optionsSuccessStatus: 200,
};

// --- Database Configuration ---
const dbConfig = {
	server:
		process.env.DB_SERVER ||
		(process.env.DATABASE_URL
			? process.env.DATABASE_URL.match(/Server=tcp:([^,]+)/)[1]
			: null),
	database:
		process.env.DB_DATABASE ||
		(process.env.DATABASE_URL
			? process.env.DATABASE_URL.match(/Initial Catalog=([^;]+)/)[1]
			: null),
	user:
		process.env.DB_USER ||
		(process.env.DATABASE_URL
			? process.env.DATABASE_URL.match(/User ID=([^;]+)/)[1]
			: null),
	password:
		process.env.DB_PASSWORD ||
		(process.env.DATABASE_URL
			? process.env.DATABASE_URL.match(/Password=([^;]+)/)[1]
			: null),
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

// Validate essential DB config from environment variables
if (!dbConfig.server || !dbConfig.database || !dbConfig.user || !dbConfig.password) {
	console.error(
		'Database configuration is incomplete. Check .env file and ensure DATABASE_URL is set correctly or individual DB_ variables are present.'
	);
	if (
		!process.env.DATABASE_URL &&
		(!process.env.DB_SERVER ||
			!process.env.DB_DATABASE ||
			!process.env.DB_USER ||
			!process.env.DB_PASSWORD)
	) {
		console.error('Missing required database environment variables.');
	}
	process.exit(1);
}

// --- Middleware ---
app.use(cors(corsOptions));
app.use(express.json());

// --- Database Connection ---
let pool;
async function connectDb() {
	try {
		console.log('Attempting to connect to database...');
		pool = await sql.connect(dbConfig);
		console.log('Database connection successful!');
		pool.on('error', (err) => console.error('Database Pool Error:', err));
	} catch (err) {
		console.error('Database Connection Failed:', err.originalError || err);
		if (err.code === 'ELOGIN') {
			console.error('Login failed. Check credentials.');
		} else if (err.code === 'ESOCKET') {
			console.error(
				'Connection error. Check server name, port, network access, and firewall rules.'
			);
		}
		process.exit(1); 
	}
}


// Base API route
app.get('/api', (req, res) => {
	res.json({ message: 'Welcome to the WYR API!' });
});

// GET random WYR question
app.get('/api/wyr/question', async (req, res) => {
	if (!pool) return res.status(503).json({ error: 'Database not connected' });
	try {
		const result = await pool.request().query(`
            SELECT TOP 1 id, optionA_text, optionB_text, optionA_votes, optionB_votes
            FROM WouldYouRatherQuestions
            WHERE is_flagged = 0
            ORDER BY NEWID();
        `);

		if (result.recordset.length === 0) {
			return res.status(404).json({ error: 'No available questions found' });
		}

		const question = result.recordset[0];
		const totalVotes = question.optionA_votes + question.optionB_votes;
		question.optionA_percentage =
			totalVotes === 0 ? 0 : Math.round((question.optionA_votes / totalVotes) * 100);
		question.optionB_percentage =
			totalVotes === 0 ? 0 : Math.round((question.optionB_votes / totalVotes) * 100);

		// Adjust percentages if rounding causes them not to sum to 100
		if (
			totalVotes > 0 &&
			question.optionA_percentage + question.optionB_percentage !== 100
		) {
			question.optionB_percentage = 100 - question.optionA_percentage;
		}
		res.json(question);
	} catch (err) {
		console.error('Error fetching question:', err);
		res.status(500).json({ error: 'Failed to fetch question' });
	}
});

// POST vote for a specific option
app.post('/api/wyr/vote/:questionId/:option', async (req, res) => {
	if (!pool) return res.status(503).json({ error: 'Database not connected' });

	const { questionId, option } = req.params;
	const voteOption = option.toUpperCase();

	if (voteOption !== 'A' && voteOption !== 'B') {
		return res
			.status(400)
			.json({ error: 'Invalid option specified. Use "A" or "B".' });
	}
	if (isNaN(parseInt(questionId))) {
		return res.status(400).json({ error: 'Invalid question ID format.' });
	}

	const columnToIncrement = voteOption === 'A' ? 'optionA_votes' : 'optionB_votes';

	try {
		const request = pool.request();
		request.input('id', sql.Int, questionId);

		const result = await request.query(`
            UPDATE WouldYouRatherQuestions
            SET ${columnToIncrement} = ${columnToIncrement} + 1
            OUTPUT INSERTED.id, INSERTED.optionA_votes, INSERTED.optionB_votes
            WHERE id = @id AND is_flagged = 0; -- Prevent voting on flagged questions
        `);

		if (result.recordset.length === 0) {
			return res
				.status(404)
				.json({ error: 'Question not found or cannot be voted on.' });
		}

		const updatedVotes = result.recordset[0];
		const totalVotes = updatedVotes.optionA_votes + updatedVotes.optionB_votes;
		const percentages = {
			optionA:
				totalVotes === 0
					? 0
					: Math.round((updatedVotes.optionA_votes / totalVotes) * 100),
			optionB:
				totalVotes === 0
					? 0
					: Math.round((updatedVotes.optionB_votes / totalVotes) * 100),
		};
		if (totalVotes > 0 && percentages.optionA + percentages.optionB !== 100) {
			percentages.optionB = 100 - percentages.optionA;
		}

		res.status(200).json({
			message: 'Vote recorded successfully',
			questionId: updatedVotes.id,
			optionAVotes: updatedVotes.optionA_votes,
			optionBVotes: updatedVotes.optionB_votes,
			percentages: percentages,
		});
	} catch (err) {
		console.error('Error recording vote:', err);
		res.status(500).json({ error: 'Failed to record vote' });
	}
});

// POST new WYR question
app.post('/api/wyr/submit', async (req, res) => {
	if (!pool) return res.status(503).json({ error: 'Database not connected' });
	const { optionA, optionB } = req.body;

	if (
		!optionA ||
		!optionB ||
		typeof optionA !== 'string' ||
		typeof optionB !== 'string' ||
		optionA.trim() === '' ||
		optionB.trim() === ''
	) {
		return res
			.status(400)
			.json({
				error: 'Both optionA and optionB must be provided as non-empty strings.',
			});
	}
	if (optionA.trim().length > 500 || optionB.trim().length > 500) {
		return res.status(400).json({ error: 'Options cannot exceed 500 characters.' });
	}
	if (optionA.trim().toLowerCase() === optionB.trim().toLowerCase()) {
		return res.status(400).json({ error: 'Options cannot be identical.' });
	}

	try {
		const request = pool.request();
		request.input('optionA', sql.NVarChar(500), optionA.trim());
		request.input('optionB', sql.NVarChar(500), optionB.trim());
		const result = await request.query(`
            INSERT INTO WouldYouRatherQuestions (optionA_text, optionB_text)
            OUTPUT INSERTED.id, INSERTED.optionA_text, INSERTED.optionB_text
            VALUES (@optionA, @optionB);
        `);
		res.status(201).json({
			message: 'Question submitted successfully',
			newQuestion: result.recordset[0],
		});
	} catch (err) {
		if (err.message.includes('CK_DistinctOptions')) {
			return res
				.status(400)
				.json({ error: 'Options cannot be identical (database check).' });
		}
		console.error('Error submitting question:', err);
		res.status(500).json({ error: 'Failed to submit question' });
	}
});

// POST to flag a question
app.post('/api/wyr/flag/:questionId', async (req, res) => {
	if (!pool) return res.status(503).json({ error: 'Database not connected' });

	const { questionId } = req.params;
	if (isNaN(parseInt(questionId))) {
		return res.status(400).json({ error: 'Invalid question ID format.' });
	}

	try {
		const request = pool.request();
		request.input('id', sql.Int, questionId);

		const result = await request.query(`
            UPDATE WouldYouRatherQuestions
            SET is_flagged = 1
            OUTPUT INSERTED.id
            WHERE id = @id AND is_flagged = 0;
        `);

		if (result.recordset.length === 0) {
			return res
				.status(404)
				.json({ error: 'Question not found or was already flagged.' });
		}

		console.log(`Question ID ${result.recordset[0].id} flagged.`);
		res.status(200).json({ message: 'Question flagged successfully.' });
	} catch (err) {
		console.error('Error flagging question:', err);
		res.status(500).json({ error: 'Failed to flag question' });
	}
});

// --- Start Server ---
connectDb()
	.then(() => {
		app.listen(port, () => {
			console.log(`Backend server running on port ${port}`);
		});
	})
	.catch(() => {
		console.error('Server failed to start due to database connection issues.');
	});
