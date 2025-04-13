// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sql = require('mssql');

const app = express();
const port = process.env.PORT || 5001;

// --- CORS Configuration ---
const allowedOrigins = [
	process.env.FRONTEND_URL, 
	'http://localhost:3000', 
];

const corsOptions = {
	origin: function (origin, callback) {
	
		if (!origin || allowedOrigins.indexOf(origin) !== -1) {
			callback(null, true);
		} else {
			console.warn(`CORS blocked for origin: ${origin}`); 
			callback(new Error('Not allowed by CORS'));
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
			: null), // Use SQL User ID
	password:
		process.env.DB_PASSWORD ||
		(process.env.DATABASE_URL
			? process.env.DATABASE_URL.match(/Password=([^;]+)/)[1]
			: null), // Use SQL Password
	port: 1433, // Default SQL Server port
	options: {
		encrypt: true, // Required for Azure SQL
		trustServerCertificate: false, // Recommended for Azure SQL
	},
	pool: {
		max: 10,
		min: 0,
		idleTimeoutMillis: 30000,
	},
};

// Add robust error checking for parsed values
if (!dbConfig.server || !dbConfig.database || !dbConfig.user || !dbConfig.password) {
	console.error(
		'Database configuration is incomplete. Check .env file and DATABASE_URL format.'
	);
	// Optionally check if DATABASE_URL itself exists if parsing failed
	if (!process.env.DATABASE_URL) {
		console.error('DATABASE_URL is missing in the .env file.');
	} else {
		console.error(
			'Could not parse all required components (Server, Initial Catalog, User ID, Password) from DATABASE_URL.'
		);
	}
	process.exit(1); // Exit if config is bad
}

// --- Middleware ---
app.use(cors(corsOptions));
app.use(express.json());

// --- Database Connection Pool ---
let pool;
async function connectDb() {
	try {
		console.log('Attempting to connect to database using SQL Authentication...');
		console.log(
			`Server: ${dbConfig.server}, Database: ${dbConfig.database}, User: ${dbConfig.user}`
		); // Log details (excluding password!)
		pool = await sql.connect(dbConfig);
		console.log('Database connection successful!');

		pool.on('error', (err) => {
			console.error('Database Pool Error:', err);
		});
	} catch (err) {
		console.error('Database Connection Failed:', err.originalError || err); // Show original error if available
		// Provide more specific feedback based on common errors
		if (err.code === 'ELOGIN') {
			console.error('Login failed. Check username and password in your .env file.');
		} else if (err.code === 'ESOCKET' && err.message.includes('ECONNREFUSED')) {
			console.error(
				'Connection refused. Check server name, port, and firewall rules.'
			);
		} else if (err.code === 'ESOCKET' && err.message.includes('ENOTFOUND')) {
			console.error('Server not found. Check the server name in your .env file.');
		} else if (err.message.includes('firewall rule')) {
			console.error(
				'Firewall rule error. Ensure your client IP address is allowed in Azure SQL Server firewall settings.'
			);
		}
		process.exit(1);
	}
}

// --- API Routes ---

// Example Test Route
app.get('/api', (req, res) => {
	res.json({ message: 'Welcome to the WYR API!' });
});

// GET a random WYR question (Simplified Flagging)
app.get('/api/wyr/question', async (req, res) => {
	if (!pool) return res.status(503).json({ error: 'Database not connected' });
	try {
		const result = await // MODIFICATION: WHERE clause checks the BIT column
		pool.request().query(`
                SELECT TOP 1
                    id,
                    optionA_text,
                    optionB_text,
                    optionA_votes,
                    optionB_votes
                FROM WouldYouRatherQuestions
                WHERE is_flagged = 0 -- Only get non-flagged questions (0 means false)
                ORDER BY NEWID();
            `);

		if (result.recordset.length === 0) {
			return res.status(404).json({ error: 'No available questions found' });
		}

		const question = result.recordset[0];
		// Calculate percentages (same logic as before)
		const totalVotes = question.optionA_votes + question.optionB_votes;
		question.optionA_percentage =
			totalVotes === 0 ? 0 : Math.round((question.optionA_votes / totalVotes) * 100);
		question.optionB_percentage =
			totalVotes === 0 ? 0 : Math.round((question.optionB_votes / totalVotes) * 100);
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

// POST a vote for a specific option
app.post('/api/wyr/vote/:questionId/:option', async (req, res) => {
	if (!pool) return res.status(503).json({ error: 'Database not connected' });
	const { questionId, option } = req.params;
	const voteOption = option.toUpperCase();
	if (voteOption !== 'A' && voteOption !== 'B') {
		return res
			.status(400)
			.json({ error: 'Invalid option specified. Use "A" or "B".' });
	}
	const columnToIncrement = voteOption === 'A' ? 'optionA_votes' : 'optionB_votes';
	try {
		const request = pool.request();
		request.input('id', sql.Int, questionId);
		const result = await request.query(`
            UPDATE WouldYouRatherQuestions
            SET ${columnToIncrement} = ${columnToIncrement} + 1
            OUTPUT INSERTED.id, INSERTED.optionA_votes, INSERTED.optionB_votes
            WHERE id = @id;
        `);
		if (result.recordset.length === 0) {
			return res.status(404).json({ error: 'Question not found' });
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

// POST a new WYR question
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
		return res.status(400).json({
			error: 'Both optionA and optionB must be provided as non-empty strings.',
		});
	}
	if (optionA.length > 500 || optionB.length > 500) {
		return res.status(400).json({ error: 'Options cannot exceed 500 characters.' });
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
		console.error('Error submitting question:', err);
		res.status(500).json({ error: 'Failed to submit question' });
	}
});

// POST to flag a specific question (Simplified Flagging)
app.post('/api/wyr/flag/:questionId', async (req, res) => {
	if (!pool) return res.status(503).json({ error: 'Database not connected' });

	const { questionId } = req.params;

	if (isNaN(parseInt(questionId))) {
		return res.status(400).json({ error: 'Invalid question ID format.' });
	}

	try {
		const request = pool.request();
		request.input('id', sql.Int, questionId);

		// Set is_flagged to 1 (true)
		const result = await request.query(`
            UPDATE WouldYouRatherQuestions
            SET is_flagged = 1 -- Set flag to true
            OUTPUT INSERTED.id -- Optional: return updated info
            WHERE id = @id AND is_flagged = 0; -- Only flag if not already flagged
        `);

		if (result.recordset.length === 0) {
			// Question not found OR it was already flagged
			return res
				.status(404)
				.json({ error: 'Question not found or was already flagged.' });
		}

		console.log(`Question ID ${result.recordset[0].id} flagged.`);
		// Changed message to reflect simpler action
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
			console.log(`Backend server running at http://localhost:${port}`);
			console.log(`Allowed frontend origin for CORS: ${process.env.FRONTEND_URL}`);
		});
	})
	.catch((err) => {
		console.error('Server failed to start due to database connection issues.');
	});
