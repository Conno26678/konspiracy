const express = require('express');
const ejs = require('ejs');
const jwt = require('jsonwebtoken');
const session = require('express-session');
const { createServer } = require('http');
const { Server } = require('socket.io');
const app = express();
const server = createServer(app);
const io = new Server(server);
const sqlite3 = require('sqlite3');
const path = require('path');
const { count } = require('console');
const dbPath = path.resolve(__dirname, 'database', 'database.db');
const db = new sqlite3.Database('database/database.db');
const bodyParser = require('body-parser');
app.use(bodyParser.urlencoded({ extended: true })); 
app.use(bodyParser.json());

io.on('connection', (socket) => {
	console.log('A user connected');

    // Send the current quiz to newly connected students if the game is already started
    if (currentQuiz) {
		console.log('Sending current quiz to newly connected user:', currentQuiz);
        socket.emit('game-started', { quiz: currentQuiz });
    }
    socket.on('disconnect', () => {
        console.log('A user disconnected');
    });
});

//replace with your oauth server url
const AUTH_URL = 'http://localhost:420/oauth';
//replace with your app url
const THIS_URL = 'http://localhost:3000/login';


function getActiveStudents(teacherClassrooms) {
	if (!teacherClassrooms) return [];

	const allStudents = teacherClassrooms.flatMap(classroom => classroom.students);
	const activeStudents = allStudents
		.filter(student => activeUsers.has(student.studentId))
		.map(student => student.displayName);
	return [...new Set(activeStudents)]; // Remove duplicates
}

// Gets all student IDs in teacher's classrooms
function studentsInClass(teacherClassrooms) {
	if (!teacherClassrooms) return [];

	const studentIds = teacherClassrooms
		.flatMap(classroom => classroom.students)
		.map(student => student.studentId);

	return [...new Set(studentIds)]; // Remove duplicates
}

// Emit event to all students in teacher's classrooms
function emitToClass(teacherSocket, eventName, data) {
	const teacherClassrooms = teacherSocket.request.session.user.classrooms;
	const studentIds = studentsInClass(teacherClassrooms);

	// Emit event to each connected student
	io.sockets.sockets.forEach(socket => {
		if (socket.userRole === 'student' && studentIds.includes(socket.userId)) {
			socket.emit(eventName, data);
		}
	});
}

// Session middleware
const sessionMiddleware = session({
	secret: 'H1!l!k3$3@0fTH3!^3$',
	resave: false,
	saveUninitialized: false
});

app.use(sessionMiddleware);

// Share session with Socket.IO
io.use((socket, next) => {
	sessionMiddleware(socket.request, {}, next);
});

io.use((socket, next) => {
	if (socket.request.session && socket.request.session.user) {
		socket.userId = socket.request.session.user.id;
		socket.userRole = socket.request.session.user.permissions === 5 ? 'teacher' : 'student';
		next();
	} else {
		next(new Error('unauthorized'));
	}
});

// Simple countdown state
let countdownActive = false;
let countdownEndTime = null;

// Socket.IO connection handling
io.on('connection', (socket) => {
	console.log(`${socket.userRole} connected`);

	// If countdown is active, tell new user the remaining time (only if they're in the right class)
	if (countdownActive && countdownEndTime) {
		const remaining = Math.ceil((countdownEndTime - Date.now()) / 1000);
		if (remaining > 0) {
			// For students, check if they're in a teacher's class that has an active countdown
			if (socket.userRole === 'student') {
				// Find if any teacher has this student in their class
				io.sockets.sockets.forEach(teacherSocket => {
					if (teacherSocket.userRole === 'teacher' && teacherSocket.request.session.user.classrooms) {
						const studentIds = studentsInClass(teacherSocket.request.session.user.classrooms);
						if (studentIds.includes(socket.userId)) {
							socket.emit('countdown:sync', { remaining });
						}
					}
				});
			} else if (socket.userRole === 'teacher') {
				socket.emit('countdown:sync', { remaining });
			}
		}
	}

	// Handle teacher starting countdown - only affect their students
	socket.on('start-countdown', () => {
		if (socket.userRole === 'teacher' && !countdownActive) {
			countdownActive = true;
			countdownEndTime = Date.now() + 5000; // 5 seconds

			// Tell the teacher
			socket.emit('countdown-start', { endTime: countdownEndTime });
			
			// Tell only students in this teacher's classes
			emitToClass(socket, 'countdown-start', { endTime: countdownEndTime });

			// Stop countdown after 5 seconds
			setTimeout(() => {
				countdownActive = false;
				countdownEndTime = null;
				
				// Tell the teacher
				socket.emit('countdown-done');
				
				// Tell only students in this teacher's classes
				emitToClass(socket, 'countdown-done');
			}, 6000);
		}
	});

	if (socket.userRole === 'student') {
		activeUsers.add(socket.userId)

		io.sockets.sockets.forEach(teacherSocket => {
			if (teacherSocket.userRole === 'teacher' && teacherSocket.request.session.user.classrooms) {
				const activeStudents = getActiveStudents(teacherSocket.request.session.user.classrooms);
				teacherSocket.emit('update-students', activeStudents);
			}
		});
	}

	if (socket.userRole === 'teacher' && socket.request.session.user.classrooms) {
		const activeStudents = getActiveStudents(socket.request.session.user.classrooms);
		socket.emit('update-students', activeStudents);
	};

	socket.on('disconnect', () => {
		console.log(`${socket.userRole} disconnected`);

		if (socket.userRole === 'student') {
			activeUsers.delete(socket.userId);

			io.sockets.sockets.forEach(teacherSocket => {
				if (teacherSocket.userRole === 'teacher' && teacherSocket.request.session.user.classrooms) {
					const activeStudents = getActiveStudents(teacherSocket.request.session.user.classrooms);
					teacherSocket.emit('update-students', activeStudents);
				}
			});
		}
	});
});

function isAuthenticated(req, res, next) {
	if (req.session.user && req.session.user.classrooms) {
		// Log all classrooms and their students
		req.session.user.classrooms.forEach((classroom) => {
			console.log(`Classroom: ${classroom.name}`);
			console.log('Students:', classroom.students);
		});
	}

	if (req.session.user) next()
	else res.redirect('/login')
};

app.set('view engine', 'ejs');

const activeUsers = new Set();

//shared state for quiz data
let currentQuiz = null;	

app.get('/login', (req, res) => {
	if (req.query.token) {
		try {
			// Decode the token
			const tokenData = jwt.decode(req.query.token);

			if (tokenData && tokenData.id) { // Check for a valid user ID
				// Save user data in the session
				req.session.user = {
					id: tokenData.id,
					email: tokenData.email,
					displayName: tokenData.displayName,
					permissions: tokenData.permissions,
					classrooms: tokenData.classrooms,
				};
				activeUsers.add(tokenData.id);
				console.log('User session saved:', req.session.user); // Debugging log
				if (tokenData.permissions === 5) {
					return res.redirect('/teacher');
				} else {
					return res.redirect('/');
				}
			} else {
				console.log('Invalid token data:', tokenData); // Debugging log
				return res.status(400).send('Invalid token');
			}
		} catch (error) {
			console.error('Error decoding token:', error.message); // Debugging log
			return res.status(400).send('Error decoding token');
		}
	} else {
		console.log('No token provided, rendering login page'); // Debugging log
		res.redirect(`${AUTH_URL}?redirectURL=${THIS_URL}`);
	}
});

app.post('/logout', (req, res) => {
	if (req.session.user) {
		// Remove the user from the activeUsers list
		activeUsers.delete(req.session.user.id);

		// Destroy the session
		req.session.destroy(err => {
			if (err) {
				console.error('Error destroying session:', err);
				return res.status(500).send('Error logging out.');
			}
			res.status(200).send('Logged out successfully.');
		});
	} else {
		res.status(400).send('No active session to log out.');
	}
});

app.get('/', isAuthenticated, (req, res) => {
    try {
		const user= req.session.user.displayName;
		return res.render('index.ejs', { user });
    } catch (error) {
        res.status(500).send(error.message);
    }
});

app.get('/teacher', isAuthenticated, (req, res) => {
	try {
		// io.on('connenction', () => {

		// Aggregate all students from all classrooms
		const allStudents = req.session.user.classrooms
			? req.session.user.classrooms.flatMap(classroom => classroom.students)
			: [];

		// Filter students who are currently signed in
		const activeStudents = allStudents
			.filter(student => activeUsers.has(student.studentId))
			.map(student => student.displayName);

		// Remove duplicates by creating a Set
		const uniqueActiveStudents = [...new Set(activeStudents)];

		// Render the teacher panel with the unique list of active students
		res.render('teacher.ejs', { students: uniqueActiveStudents });
		// });
	} catch (error) {
		console.log(error.message);
		res.status(500).send('An error occurred while loading the teacher page.');
	}
});

app.post('/teacher', isAuthenticated, (req, res) => {
	const selectedQuiz = req.body.selectedQuiz;
	console.log(`Selected quiz: ${selectedQuiz}`);
	
	// Find the quiz UID in the database
    db.get('SELECT uid FROM quizzes WHERE quizname = ?', [selectedQuiz], (err, row) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).send('Database error');
        }
        if (!row) {
            return res.status(404).send('Quiz not found');
        }

        // Store the UID in the session for later use
        req.session.selectedQuizUid = row.uid;
        console.log(`Stored quiz UID in session: ${row.uid}`);
		res.redirect('/quiz');
	});
});

app.get('/quiz', isAuthenticated, (req, res) => {
	const quizUid = req.session.selectedQuizUid;
	console.log(`Quiz UID retrieved from session: ${quizUid}`);
	try {
		db.all(
			`SELECT * FROM quizzes 
			   INNER JOIN quizquestions ON quizzes.uid = quizquestions.quizid
			   INNER JOIN questionanswers ON quizquestions.uid = questionanswers.questionid
			   WHERE quizzes.uid = ?`, [quizUid],
			(err, rows) => {
				if (err) {
					throw err;
				}

				// Initialize the quiz object
				let quiz = {
					uid: rows[0].uid,
					ownerid: rows[0].ownerid,
					title: rows[0].quizname,
					questions: []
				};

				// Temporary object to group questions by questionid
				const groupedQuestions = {};
				let questionIndex = 0;

				rows.forEach((row) => {
					// Check if the question already exists in the groupedQuestions object
					if (!groupedQuestions[row.questionid]) {
						groupedQuestions[row.questionid] = {
							question: row.questions,
							answers: []
						};
					}

					// Add the current row's answer to the corresponding question's answers array
					groupedQuestions[row.questionid].answers.push({
						answer: row.answers,
						correct: row.correct
					});
				});
				
				// Convert groupedQuestions into an array and add it to the quiz object
				quiz.questions = Object.values(groupedQuestions);

				res.render('quiz.ejs', { 
					quiz: quiz,
					questionNumber: questionIndex
				});
			}
		);
	} catch (error) {
		res.send(error.message)
	}
});
server.listen(3000, () => {
	console.log('Server is running on http://localhost:3000');
});