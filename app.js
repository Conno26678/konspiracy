const express = require('express');
const ejs = require('ejs');
const jwt = require('jsonwebtoken');
const session = require('express-session');
const { createServer } = require('http');
const { Server } = require('socket.io');
const app = express();
const sqlite3 = require('sqlite3');
const path = require('path');
const { count } = require('console');
const dbPath = path.resolve(__dirname, 'database', 'database.db');
const db = new sqlite3.Database('database/database.db');
const http = require('http');
const server = http.createServer(app);
const io = new Server(server);
const bodyParser = require('body-parser');
app.use(bodyParser.urlencoded({ extended: true })); 
app.use(bodyParser.json());

const gameStates = {
	lobby: 'lobby',
	countdown: 'countdown',
	gettingAnswers: 'gettingAnswers',
	review: 'review',
	gameOver: 'gameOver'
};

// Fix the Game constructor
class Game {
    constructor(teacherId, quiz) {  // Add missing parameters
        this.id = `game-${Date.now()}_${teacherId}`;
        this.teacherId = teacherId;
        this.quiz = quiz;
        this.state = gameStates.lobby;
        this.currentQuestionIndex = 0;
        this.playerAnswers = new Map();
        this.createdAt = Date.now();
        this.students = new Set();
        this.countdownEndTime = null;
        this.questionStartTime = null;
    }
	
	currentQuestion() {
		if (this.currentQuestionIndex < this.quiz.questions.length) {
			return this.quiz.questions[this.currentQuestionIndex];
		}
		return null;
	};
	
	nextQuestion() {
		this.currentQuestionIndex++;
		this.playerAnswers.clear();
		
		if (this.currentQuestionIndex >= this.quiz.questions.length) {
			this.state = gameStates.gameOver;
		} else {
			this.state = gameStates.countdown;
		}};
		
	addStudent(studentId) {
		this.students.add(studentId);
	};

	removeStudent(studentId) {
		this.students.delete(studentId);
		this.playerAnswers.delete(studentId);
	}

	getGameStateData() {
        return {
            gameId: this.id,
            state: this.state,
            quiz: {
                title: this.quiz.title,
                totalQuestions: this.quiz.questions.length
            },
            currentQuestionIndex: this.currentQuestionIndex,
            currentQuestion: this.currentQuestion(),
            countdownEndTime: this.countdownEndTime,
            studentsConnected: this.students.size,
            answersReceived: this.playerAnswers.size
        };
    }
	};

const activeGames = new Map(); // gameId -> Game instance

function teacherGames(teacherId) {
	return activeGames.get(teacherId);
}

function findGame(studentId, teacherClassrooms) {
    // First check if student is already in an active game
    for (const [teacherId, game] of activeGames.entries()) {
        if (game.students.has(studentId)) {
            return game;
        }
    }
    
    // If not in a game, check if student belongs to any teacher with active games
    for (const [teacherId, game] of activeGames.entries()) {
        const hasStudent = teacherClassrooms && teacherClassrooms.some(classroom => 
            classroom.students.some(student => student.studentId === studentId)
        );
        if (hasStudent) {
            game.addStudent(studentId);
            return game;
        }
    }
    return null;
}

function cleanUpGameEnd() {
	for (const [teacherId, game] of activeGames.entries()) {
		if (game.state === gameStates.gameOver) {
			activeGames.delete(teacherId)
		}
	}
}



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

	if (socket.userRole === 'teacher') {
		const game = teacherGames(socket.userId);
		if(game) {
			socket.emit('game-state', game.getGameStateData());
		}
	} else if (socket.userRole === 'student') {
		const studentClassrooms = socket.request.session.user.classrooms || [];
		const game = findGame(socket.userId, studentClassrooms);
		if (game) {
			socket.emit('game-state', game.getGameStateData());
		}
	}

	socket.on('start-game', (quizData) => {
		if (socket.userRole === 'teacher') {
			const game = new Game(socket.userId, quizData);
			activeGames.set(socket.userId, game);

			const teacherClassrooms = socket.request.session.user.classrooms;
			const studentIds = studentsInClass(teacherClassrooms);
			studentIds.forEach(studentId => game.addStudent(studentId));

			socket.emit('game-state', game.getGameStateData());
			emitToClass(socket, 'game-state', game.getGameStateData());

			console.log(`Game started by teacher ${socket.userId}`);
		}
	});

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

// Handle teacher starting countdown
    socket.on('start-countdown', () => {
        if (socket.userRole === 'teacher') {
            const game = teacherGames(socket.userId);  // Use correct function name
            if (game && game.state === gameStates.lobby) {
                game.state = gameStates.countdown;
                game.countdownEndTime = Date.now() + 5000; // 5 seconds

                const gameStateData = game.getGameStateData();
                socket.emit('game-state', gameStateData);
                emitToClass(socket, 'game-state', gameStateData);

                // After countdown, move to getting answers
                setTimeout(() => {
                    game.state = gameStates.gettingAnswers;
                    game.questionStartTime = Date.now();
                    game.countdownEndTime = null;
                    
                    const updatedStateData = game.getGameStateData();
                    socket.emit('game-state', updatedStateData);
                    emitToClass(socket, 'game-state', updatedStateData);
                }, 6000);
            }
        }
    });

	socket.on('submit-answer', (answer) => {
		if (socket.userRole === 'student') {
			// Get student's classroom data from session or database
			const studentClassrooms = socket.request.session.user.classrooms || [];
			const game = findGame(socket.userId, studentClassrooms);

			if (game && game.state === gameStates.gettingAnswers) {
				game.playerAnswers.set(socket.userId, answer);

				if (game.playerAnswers.size === game.students.size) {
					game.state = gameStates.review;

					// Find teacher socket and notify
					io.sockets.sockets.forEach(teacherSocket => {
						if (teacherSocket.userRole === 'teacher' && teacherSocket.userId === game.teacherId) {
							teacherSocket.emit('answers-received');
							teacherSocket.emit('game-state', game.getGameStateData());
						}
					});
				}
			}
		}
	});

	socket.on('next-question', () => {
		if (socket.userRole === 'teacher') {
			const game = teacherGames(socket.userId);
			if (game && game.state === gameStates.review) {
				game.nextQuestion();

				const gameStateData = game.getGameStateData();
				socket.emit('game-state', gameStateData);
			}
		}
	});

	socket.on('end-game', () => {
		if (socket.userRole === 'teacher') {
			const game = teacherGames(socket.userId);
			if (game) {
				game.state = gameStates.gameOver;

				const gameStateData = game.getGameStateData();
				socket.emit('game-state', gameStateData);
				emitToClass(socket, 'game-state', gameStateData);

				setTimeout(() => {
					activeGames.delete(socket.userId);
				}, 10000);
			}
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

		for (const game of activeGames.values()) {
			game.removeStudent(socket.userId);
		}

			activeUsers.delete(socket.userId);

			io.sockets.sockets.forEach(teacherSocket => {
				if (teacherSocket.userRole === 'teacher' && teacherSocket.request.session.user.classrooms) {
					const activeStudents = getActiveStudents(teacherSocket.request.session.user.classrooms);
					teacherSocket.emit('update-students', activeStudents);
				}
			});
		} else if (socket.userRole === 'teacher') {
			const game = teacherGames(socket.userId);
			if (game) {
				game.state = gameStates.gameOver;
				emitToClass(socket, 'game-state', {reason: 'Teacher disconnected, game ended.'});
			}
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

        // Load quizzes + questions + answers
        const sql = `
            SELECT 
                q.uid            AS quizUid,
                q.quizname       AS quizname,
                qq.uid           AS questionId,
                qq.questions     AS questionText,
                qa.answers       AS answerText,
                qa.correct       AS correct
            FROM quizzes q
            INNER JOIN quizquestions qq ON q.uid = qq.quizid
            INNER JOIN questionanswers qa ON qq.uid = qa.questionid
            ORDER BY q.quizname, qq.uid, qa.rowid
        `;
        db.all(sql, [], (err, rows) => {
            if (err) {
                console.error('DB error loading quizzes', err);
                return res.status(500).send('Database error');
            }
            const quizzes = {};
            // Structure to match existing front-end (questions array + parallel answers array)
            rows.forEach(r => {
                if (!quizzes[r.quizname]) {
                    quizzes[r.quizname] = {
                        title: r.quizname,
                        questions: [],
                        answers: [],
                        _qIndex: {} // temp: questionId -> index
                    };
                }
                const qObj = quizzes[r.quizname];
                if (qObj._qIndex[r.questionId] === undefined) {
                    qObj._qIndex[r.questionId] = qObj.questions.length;
                    qObj.questions.push(r.questionText);
                    qObj.answers.push({}); // placeholder object mapping answer -> bool
                }
                const qi = qObj._qIndex[r.questionId];
                qObj.answers[qi][r.answerText] = !!r.correct;
            });
            // Cleanup temp
            Object.values(quizzes).forEach(q => delete q._qIndex);

            res.render('teacher.ejs', {
                students: uniqueActiveStudents,
                quizzes
            });
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error loading teacher page.');
    try {
        const activeStudents = getActiveStudents(req.session.user.classrooms);
        
        // Check if teacher has an active game
        const activeGame = teacherGames(req.session.user.id);
        
        res.render('teacher.ejs', { 
            students: activeStudents,
            activeGame: activeGame ? activeGame.getGameStateData() : null
        });
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
		res.redirect('/quiz');
	});
});

function loadQuizByUid(uid, cb) {
    const sql = `
        SELECT 
            q.uid            AS quizUid,
            q.quizname       AS quizname,
            qq.uid           AS questionId,
            qq.questions     AS questionText,
            qa.answers       AS answerText,
            qa.correct       AS correct
        FROM quizzes q
        INNER JOIN quizquestions qq ON q.uid = qq.quizid
        INNER JOIN questionanswers qa ON qq.uid = qa.questionid
        WHERE q.uid = ?
        ORDER BY qq.uid, qa.rowid
    `;
    db.all(sql, [uid], (err, rows) => {
        if (err) return cb(err);
        if (!rows.length) return cb(null, null);
        const quiz = {
            uid: rows[0].quizUid,
            title: rows[0].quizname,
            questions: []
        };
        const qMap = {};
        rows.forEach(r => {
            if (!qMap[r.questionId]) {
                qMap[r.questionId] = { question: r.questionText, answers: [] };
                quiz.questions.push(qMap[r.questionId]);
            }
            qMap[r.questionId].answers.push({
                answer: r.answerText,
                correct: !!r.correct
            });
        });
        cb(null, quiz);
    });
}

app.get('/quiz', isAuthenticated, (req, res) => {
    const quizUid = req.session.selectedQuizUid;
    if (!quizUid) return res.redirect('/teacher');
    const questionIndex = parseInt(req.query.question || '0', 10);

    loadQuizByUid(quizUid, (err, quiz) => {
        if (err) return res.status(500).send('DB error');
        if (!quiz) return res.redirect('/teacher');
        const safeIndex = Math.max(0, Math.min(questionIndex, quiz.questions.length - 1));
        res.render('quiz.ejs', {
            quiz,
            questionNumber: safeIndex
        });
    });
});

app.get('/review', isAuthenticated, (req, res) => {
    const quizUid = req.session.selectedQuizUid;
    if (!quizUid) return res.redirect('/teacher');
    const questionNumber = parseInt(req.query.question || '0', 10);

    loadQuizByUid(quizUid, (err, quiz) => {
        if (err) return res.status(500).send('DB error');
        if (!quiz) return res.redirect('/teacher');
        if (questionNumber < 0 || questionNumber >= quiz.questions.length) {
            return res.redirect('/teacher');
        }
        const isLast = questionNumber === quiz.questions.length - 1;
        res.render('review.ejs', {
            quiz,
            questionNumber,
            isLast
        });
    });
});
server.listen(3000, () => {
	console.log('Server is running on http://localhost:3000');
});